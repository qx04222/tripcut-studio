import type { ClipListItem } from "../api";
import { photoSizeLabel } from "./photoModel";

export function PhotoInspector({ clip }: { clip: ClipListItem }) {
  const photo = clip.photo;
  const camera = photo?.camera ?? clip.device_model;
  const gpsLat = photo?.gps_lat ?? null;
  const gpsLon = photo?.gps_lon ?? null;
  const validGps = gpsLat !== null && gpsLon !== null && Number.isFinite(gpsLat) && Number.isFinite(gpsLon);
  return <section className="photo-r21-metadata" role="group" aria-label="照片信息">
    <dl>
      {photo?.raw_container ? <div><dt>格式</dt><dd>{photo.raw_container.toUpperCase()} · RAW</dd></div> : null}
      {photo?.preview_source ? <div><dt>预览来源</dt><dd>{photo.preview_source === "embedded" ? `内嵌预览 ${photo.embedded_preview_width}×${photo.embedded_preview_height}` : `原图解码 ${photo.preview_width}×${photo.preview_height}`}</dd></div> : null}
      {photo?.preview_small ? <div><dt>提示</dt><dd>RAW 预览较小</dd></div> : null}
      <div><dt>尺寸</dt><dd>{photoSizeLabel(clip)}</dd></div>
      {photo?.taken_at ? <div><dt>拍摄时间</dt><dd>{photo.taken_at_local ?? photo.taken_at}</dd></div> : null}
      {camera ? <div><dt>机身</dt><dd>{camera}</dd></div> : null}
      {photo?.lens ? <div><dt>镜头</dt><dd>{photo.lens}</dd></div> : null}
      {validGps ? <div><dt>GPS</dt><dd>{gpsLat}, {gpsLon}</dd></div> : null}
    </dl>
  </section>;
}
