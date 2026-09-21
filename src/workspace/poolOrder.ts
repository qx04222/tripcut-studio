import type { ClipListItem } from "../api";

/**
 * 媒体池当前可见顺序的一份只读快照(R11 §3「播完自动下一条」)。媒体池每次算完可见
 * 列表就写进来;监视器播到尾时按它找下一条。不进 WorkspaceStore —— 这份列表随筛选 /
 * 搜索 / 虚拟化每次重算,塞进 store 会让所有订阅者跟着重渲染。
 */
let order: readonly number[] = [];

export function setPoolOrder(ids: readonly number[]): void {
  order = ids;
}

export function getPoolOrder(): readonly number[] {
  return order;
}

/** 当前素材在可见顺序里的下一条;末尾或不在列表里 → null(末尾停,规格 §3)。 */
export function nextPoolClipId(currentId: number): number | null {
  const index = order.indexOf(currentId);
  if (index < 0 || index + 1 >= order.length) return null;
  return order[index + 1] ?? null;
}

export function __resetPoolOrderForTests(): void {
  order = [];
}

export interface PoolWallClock {
  date: string;
  hour: number;
  /** 把钟面字段当 UTC 数值排序,因此不受审片 Mac 时区影响。 */
  sortValue: number;
}

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/;

function wallClockFromRfc3339(value: string | null | undefined): PoolWallClock | null {
  const match = value?.match(WALL_CLOCK_PATTERN);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const milliseconds = Number((match[7] ?? "").slice(0, 3).padEnd(3, "0"));
  if (hour! > 23 || minute! > 59 || second! > 59) return null;
  const sortValue = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, milliseconds);
  const check = new Date(sortValue);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;
  return { date: `${match[1]}-${match[2]}-${match[3]}`, hour: hour!, sortValue };
}

function photoOffsetMinutes(clip: ClipListItem): number | null {
  const match = (clip.photo?.tz_guess ?? clip.tz_guess)?.match(/^UTC([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function wallClockFromInstant(value: string | null | undefined, offsetMinutes: number): PoolWallClock | null {
  const instant = Date.parse(value ?? "");
  if (!Number.isFinite(instant)) return null;
  const sortValue = instant + offsetMinutes * 60_000;
  const shifted = new Date(sortValue);
  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    date: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    hour: shifted.getUTCHours(),
    sortValue,
  };
}

/** 照片按拍摄地钟面;视频保持按审片 Mac 本地钟面。 */
export function poolWallClock(clip: ClipListItem): PoolWallClock | null {
  if (clip.kind === "photo") {
    return wallClockFromRfc3339(clip.photo?.taken_at_local)
      ?? wallClockFromInstant(clip.photo?.taken_at ?? clip.captured_at, photoOffsetMinutes(clip) ?? 0);
  }
  const instant = Date.parse(clip.captured_at ?? "");
  if (!Number.isFinite(instant)) return null;
  const at = new Date(instant);
  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    hour: at.getHours(),
    sortValue: instant,
  };
}

export function poolCapturedAt(clip: ClipListItem): string | null {
  return (clip.kind === "photo" ? clip.photo?.taken_at_local ?? clip.photo?.taken_at : null) ?? clip.captured_at;
}

/** 照片工作台的排序键:拍摄地钟面优先,时间未知稳定置后。 */
export function poolCapturedSortValue(clip: ClipListItem): number {
  if (clip.kind === "photo") return poolWallClock(clip)?.sortValue ?? Number.POSITIVE_INFINITY;
  const value = Date.parse(poolCapturedAt(clip) ?? "");
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

/** Keep existing video-only ordering; mixed pools use capture time, unknown dates last. */
export function sortPoolClips(clips: readonly ClipListItem[]): ClipListItem[] {
  if (!clips.some(clip => clip.kind === "photo")) return [...clips];
  const photoOnly = clips.every(clip => clip.kind === "photo");
  const time = (clip: ClipListItem) => {
    if (photoOnly) return poolCapturedSortValue(clip);
    const value = Date.parse(poolCapturedAt(clip) ?? "");
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  };
  return [...clips].sort((a, b) => time(a) - time(b));
}
