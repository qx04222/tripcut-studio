import type { ClipListItem } from "../api";

/** ImageIO bakes orientation into previews; swap metadata axes, never rotate pixels again. */
export function photoDimensions(clip: Pick<ClipListItem, "photo">): { width: number; height: number } | null {
  const photo = clip.photo;
  if (!photo || !Number.isFinite(photo.width) || !Number.isFinite(photo.height) || photo.width <= 0 || photo.height <= 0) return null;
  return [5, 6, 7, 8].includes(photo.orientation)
    ? { width: photo.height, height: photo.width } : { width: photo.width, height: photo.height };
}
export function photoSizeLabel(clip: Pick<ClipListItem, "photo">): string {
  const size = photoDimensions(clip);
  return size ? `${size.width}×${size.height}` : "尺寸未知";
}
export function photoHoldMs(value?: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 3000;
}
export function photoHoldLabel(value?: number | null): string {
  return `${Number((photoHoldMs(value) / 1000).toFixed(1))} s`;
}
/** photo-core 的 CompanionDto.role 是英文标识(raw / xmp / live_mov / jpg);卡片里显示给人看的名字。 */
export function companionRoleLabel(role: string): string {
  switch (role) {
    case "raw": return "RAW";
    case "xmp": return "XMP";
    case "live_mov": return "Live 视频";
    case "jpg": return "JPG";
    default: return role;
  }
}
