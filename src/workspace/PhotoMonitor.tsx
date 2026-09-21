import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import { listSimilarGroups, rateClip, setSimilarPrimary, type ClipListItem, type SimilarGroup } from "../api";
import { notifySimilarGroupsChanged, requestDuel } from "./duel/duelBus";
import { photoSizeLabel } from "./photoModel";
import { getPoolOrder, sortPoolClips } from "./poolOrder";
import { isSuspectedJunk } from "./photoWorkspaceModel";
import { PHOTO_ZOOM_MODES, photoZoomLabel, usePhotoZoom } from "./photoZoom";
import { Button } from "./ui";
import { refreshClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";

function exifValues(clip: ClipListItem): string[] {
  const photo = clip.photo;
  return [
    photo ? photoSizeLabel(clip) : null,
    photo?.taken_at_local,
    photo?.camera,
    photo?.lens,
    photo?.color_space,
    clip.byte_size ? `${(clip.byte_size / 1_048_576).toFixed(1)} MB` : null,
    clip.iso_value != null ? `ISO ${clip.iso_value}` : null,
    clip.shutter_speed,
    clip.aperture,
  ].filter((value): value is string => Boolean(value));
}

function editableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input,textarea,select,[contenteditable=true]"));
}

export function PhotoMonitor({ clip, clips, rootRef }: {
  clip: ClipListItem; clips: readonly ClipListItem[]; rootRef: RefObject<HTMLDivElement | null>;
}): JSX.Element {
  const readOnly = useWorkspace((state) => state.viewingEpisode !== null);
  const [failed, setFailed] = useState<string | null>(null);
  const [groups, setGroups] = useState<readonly SimilarGroup[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const pointerInside = useRef(false);
  const zoom = usePhotoZoom(clip.id);
  const url = clip.photo?.preview_url ?? clip.cover_url;
  const visible = getPoolOrder();
  const photos = useMemo(() => (visible.length > 0
    ? visible.map((id) => clips.find((item) => item.id === id)).filter((item): item is ClipListItem => item !== undefined)
    : sortPoolClips(clips)).filter((item) => item.kind === "photo"), [clips, visible]);
  const index = photos.findIndex((item) => item.id === clip.id);
  const group = groups.find((item) => item.members.some((member) => member.clip_id === clip.id));
  const groupMember = group?.members.find((member) => member.clip_id === clip.id);
  const duelClipIds = group?.members
    .map((member) => member.clip_id)
    .filter((id) => {
      const candidate = clips.find((item) => item.id === id);
      return candidate?.kind === "photo" && !candidate.missing_since && candidate.binary_rating !== -1;
    }) ?? [];

  const step = useCallback((direction: -1 | 1) => {
    const id = photos[index + direction]?.id;
    if (id !== null && id !== undefined) dispatchWorkspace({ type: "select-clip", clipId: id });
  }, [index, photos]);
  const run = useCallback(async (key: string, action: () => Promise<unknown>) => {
    if (readOnly || busy) return;
    setBusy(key); setError(null);
    try { await action(); await refreshClipsFeed(true); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  }, [busy, readOnly]);

  useEffect(() => {
    let live = true;
    void listSimilarGroups().then((rows) => { if (live) setGroups(rows); }).catch(() => { if (live) setGroups([]); });
    return () => { live = false; };
  }, [clip.id]);
  useEffect(() => { setFailed(null); setError(null); }, [clip.id]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => { event.preventDefault(); zoom.wheel(event.deltaY); };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoom.wheel]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || editableTarget(event.target)) return;
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      const focusInside = active !== null && root.contains(active);
      const explicitFocusOutside = active !== null
        && active !== document.body
        && active !== document.documentElement
        && !focusInside;
      if (explicitFocusOutside) return;
      if (!pointerInside.current && !focusInside) return;
      const key = event.key.toLowerCase();
      let handled = true;
      if (event.altKey && event.key === "ArrowLeft") zoom.nudge(-40, 0);
      else if (event.altKey && event.key === "ArrowRight") zoom.nudge(40, 0);
      else if (event.altKey && event.key === "ArrowUp") zoom.nudge(0, -40);
      else if (event.altKey && event.key === "ArrowDown") zoom.nudge(0, 40);
      else if (!event.metaKey && !event.ctrlKey && event.key === "ArrowLeft") step(-1);
      else if (!event.metaKey && !event.ctrlKey && event.key === "ArrowRight") step(1);
      else if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "z") zoom.cycle();
      else if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "f" && clip.id !== null) void run("keep", () => rateClip(clip.id!, "binary", 1));
      else if (!event.metaKey && !event.ctrlKey && !event.altKey && key === "x" && clip.id !== null) void run("reject", () => rateClip(clip.id!, "binary", -1));
      else if (!event.metaKey && !event.ctrlKey && !event.altKey && /^[1-5]$/.test(event.key) && clip.id !== null) {
        const star = Number(event.key);
        void run(`star-${star}`, () => rateClip(clip.id!, "star", star));
      }
      else handled = false;
      if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [clip.id, run, step, zoom]);

  const disabled = readOnly || busy !== null || clip.id === null;
  return (
    <div
      className="photo-monitor-r21"
      ref={rootRef}
      aria-label="照片检视器"
      tabIndex={-1}
      onPointerEnter={() => { pointerInside.current = true; }}
      onPointerLeave={() => { pointerInside.current = false; }}
    >
      <header className="photo-monitor-head"><strong>照片检视</strong><span title={clip.file_name}>{clip.file_name}</span><b>{index >= 0 ? `${index + 1} / ${photos.length}` : "—"}</b></header>
      <div ref={canvasRef} className={`photo-monitor-canvas is-${zoom.mode}`} role="group" aria-label="照片查看区" onPointerDown={zoom.onPointerDown} onPointerMove={zoom.onPointerMove} onPointerUp={zoom.onPointerUp} onPointerCancel={zoom.onPointerUp}>
        {url && failed !== url ? <img className="photo-monitor-image" style={zoom.imageStyle} src={url} alt={`照片预览 ${clip.file_name}`} crossOrigin="anonymous" draggable={false} onError={() => setFailed(url)} />
          : <p role="status">{url ? "照片预览加载失败" : "照片预览准备中"}</p>}
        {isSuspectedJunk(clip) ? <span className="photo-monitor-junk">疑似废片</span> : null}
      </div>
      <div className="photo-monitor-toolbar" role="toolbar" aria-label="照片检视工具">
        <Button size="sm" disabled={index <= 0} onClick={() => step(-1)}>上一张</Button>
        <Button size="sm" disabled={index < 0 || index >= photos.length - 1} onClick={() => step(1)}>下一张</Button>
        <div className="photo-monitor-zoom" role="group" aria-label="照片缩放">
          {PHOTO_ZOOM_MODES.map((mode) => <Button key={mode} size="sm" aria-pressed={zoom.mode === mode} onClick={() => zoom.choose(mode)}>{photoZoomLabel(mode)}</Button>)}
        </div>
        <Button size="sm" busy={busy === "keep"} disabled={disabled} aria-pressed={clip.binary_rating === 1} onClick={() => void run("keep", () => rateClip(clip.id!, "binary", 1))}>保留 F</Button>
        <Button size="sm" tone="danger" busy={busy === "reject"} disabled={disabled} aria-pressed={clip.binary_rating === -1} onClick={() => void run("reject", () => rateClip(clip.id!, "binary", -1))}>拒绝 X</Button>
      </div>
      <div className="photo-monitor-rating" role="group" aria-label="照片星级">
        {[1, 2, 3, 4, 5].map((star) => <Button key={star} size="sm" disabled={disabled} busy={busy === `star-${star}`} aria-pressed={clip.star_rating === star} aria-label={`${star} 星`} onClick={() => void run(`star-${star}`, () => rateClip(clip.id!, "star", star))}>{star}★</Button>)}
        {group && group.members.length > 1 ? <>
          <Button
            size="sm"
            disabled={readOnly || busy !== null || duelClipIds.length < 2}
            title={duelClipIds.length < 2 ? "至少需要两张未被 X 拒绝的照片；先按 F 保留、清除评级，或换一张。" : undefined}
            onClick={() => requestDuel({ clipIds: duelClipIds, source: "similar_group" })}
          >组内对比 {duelClipIds.length} 张</Button>
          {groupMember?.is_primary ? <span className="photo-monitor-primary">本组主图</span> : <Button size="sm" disabled={disabled} busy={busy === "primary"} onClick={() => void run("primary", async () => {
            await setSimilarPrimary(group.id, clip.id!);
            setGroups((rows) => rows.map((row) => row.id === group.id ? { ...row, members: row.members.map((member) => ({ ...member, is_primary: member.clip_id === clip.id })) } : row));
            notifySimilarGroupsChanged();
          })}>设为主图</Button>}
        </> : null}
      </div>
      <dl className="photo-monitor-exif" aria-label="照片 EXIF 快速信息">{exifValues(clip).map((value) => <div key={value}><dd>{value}</dd></div>)}</dl>
      <p className="photo-monitor-hint">1–5 星级 · ← → 换片 · Z 切换倍率 · 滚轮缩放 · 放大后拖动或 ⌥+方向键平移</p>
      {error ? <p role="alert" className="photo-monitor-error">操作失败：{error}</p> : null}
    </div>
  );
}
