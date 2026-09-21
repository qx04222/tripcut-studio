import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from "react";
import { getSettings } from "../api";
import { PaneHead } from "./PaneHead";
import { featuredPhotos, moveVisiblePhoto, moveVisiblePhotoTo } from "./photoWorkspaceModel";
import { Button, CoverImage } from "./ui";
import { useClipsFeed } from "./useClipsFeed";
import { dispatchWorkspace, useWorkspace } from "./WorkspaceStore";
import { PHOTO_ORDER_SAVE_ERROR, photoOrderKey, savePhotoOrder } from "./photoOrderSettings";
import { showToast } from "./ui/Toast";

function parseOrder(raw: string | undefined): number[] {
  try { const value: unknown = JSON.parse(raw ?? "[]"); return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : []; }
  catch { return []; }
}

export function PhotoFeaturedStrip(): JSX.Element {
  const feed = useClipsFeed();
  const selected = useWorkspace((state) => state.selection?.kind === "clip" ? state.selection.clipId : null);
  const readOnly = useWorkspace((state) => state.viewingEpisode !== null);
  const episodeId = feed.episode.scopeId;
  const [order, setOrder] = useState<number[]>([]);
  const dragging = useRef<number | null>(null);
  const key = photoOrderKey(episodeId);
  const readVersion = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    const version = readVersion.current + 1;
    readVersion.current = version;
    let live = true;
    void getSettings().then((settings) => {
      if (live && readVersion.current === version && currentKey.current === key) setOrder(parseOrder(settings[key]));
    }).catch(() => undefined);
    return () => { live = false; };
  }, [key]);
  const candidates = useMemo(() => featuredPhotos(feed.clips, order), [feed.clips, order]);
  const candidateIds = useMemo(() => candidates.map((clip) => clip.id!), [candidates]);
  useEffect(() => {
    const ids = candidates.map((clip) => clip.id!).filter((id) => !order.includes(id));
    if (ids.length > 0) setOrder((current) => [...current, ...ids]);
  }, [candidates, order]);
  const save = (next: number[]) => {
    if (readOnly) return;
    readVersion.current += 1;
    setOrder(next);
    void savePhotoOrder(key, next).catch(() => showToast(PHOTO_ORDER_SAVE_ERROR, { tone: "danger" }));
  };
  const drop = (event: DragEvent, target: number) => {
    event.preventDefault();
    if (readOnly) return;
    const source = dragging.current;
    if (source === null || source === target) return;
    save(moveVisiblePhotoTo(order, source, target, candidateIds));
  };
  return (
    <section className="photo-ws-featured" aria-label="照片精选带" data-pane="band" tabIndex={-1}>
      <PaneHead title="精选带" meta={`${candidates.length} 张`} />
      <div className="photo-ws-featured-scroll" role="list" aria-label="照片精选顺序">
        {candidates.map((clip, index) => (
          <article key={clip.id} role="listitem" draggable={!readOnly} className={selected === clip.id ? "photo-ws-featured-card is-selected" : "photo-ws-featured-card"}
            onDragStart={() => { dragging.current = clip.id; }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, clip.id!)}>
            <button type="button" aria-label={`检视照片 · ${clip.file_name}`} onClick={() => dispatchWorkspace({ type: "select-clip", clipId: clip.id! })}>
              <CoverImage src={clip.photo?.preview_url ?? clip.cover_url} lazy />
              <span>{index + 1}</span><strong>{clip.file_name}</strong>
            </button>
            <span className="photo-ws-order-buttons">
              <Button size="sm" variant="ghost" aria-label={`前移 · ${clip.file_name}`} disabled={readOnly || index === 0} onClick={() => save(moveVisiblePhoto(order, clip.id!, -1, candidateIds))}>←</Button>
              <Button size="sm" variant="ghost" aria-label={`后移 · ${clip.file_name}`} disabled={readOnly || index === candidates.length - 1} onClick={() => save(moveVisiblePhoto(order, clip.id!, 1, candidateIds))}>→</Button>
            </span>
          </article>
        ))}
        {candidates.length === 0 ? <p className="photo-ws-empty">收藏、三星以上或自动挑中的照片会进入精选带。</p> : null}
      </div>
    </section>
  );
}
