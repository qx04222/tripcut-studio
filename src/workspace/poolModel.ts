import { analysisBadgeKinds, type AnalysisBadgeKind } from "../AnalysisPanel";
import type { ClipDimension, ClipDimensionKey, ClipListItem, ShotStack } from "../api";

/**
 * 媒体池的纯函数层。这些函数**逐字搬自** `SelectPage.tsx`(签名一行没改),
 * 好让新壳的媒体池与旧壳的胶片墙共用同一份实现 —— 两边各留一份筛选逻辑,
 * 迟早会在其中一边悄悄改歪。`SelectPage.tsx` 现在从这里 re-export,
 * 它原有的断言原样通过。
 */

export type SelectionFilter = "all" | "favorite" | "unrated" | "rejected";
export type OrientationFilter = "all" | "portrait" | "landscape";

export interface ShotStackWallItem {
  clip: ClipListItem;
  stack?: ShotStack;
  semanticScore?: number;
}

const SUSPECT_BADGES = new Set<AnalysisBadgeKind>([
  "dark",
  "overexposed",
  "clipped",
  "soft_focus",
]);

export const GRID_GAP = 14;
export const FILM_GRID_MIN_WIDTH = 280;
export const GRID_ROW_HEIGHT = 260;
export const STACK_DETAIL_HEIGHT = 300;
export const GRID_OVERSCAN_ROWS = 2;
export const GRID_HORIZONTAL_PADDING = 24;

export function filmRowTop(row: number, expandedRow: number | null): number {
  return row * GRID_ROW_HEIGHT + (expandedRow !== null && row > expandedRow ? STACK_DETAIL_HEIGHT : 0);
}

export function filmRowAtOffset(offset: number, expandedRow: number | null): number {
  if (expandedRow === null || offset < (expandedRow + 1) * GRID_ROW_HEIGHT) {
    return Math.max(0, Math.floor(offset / GRID_ROW_HEIGHT));
  }
  if (offset < (expandedRow + 1) * GRID_ROW_HEIGHT + STACK_DETAIL_HEIGHT) return expandedRow;
  return Math.max(0, Math.floor((offset - STACK_DETAIL_HEIGHT) / GRID_ROW_HEIGHT));
}

export function filmGridColumnCount(viewportWidth: number): number {
  const contentWidth = Math.max(0, viewportWidth - GRID_HORIZONTAL_PADDING);
  return Math.max(
    1,
    Math.floor((contentWidth + GRID_GAP) / (FILM_GRID_MIN_WIDTH + GRID_GAP)),
  );
}

/**
 * 新增:媒体池栏宽 260–480(规格 §2)下的列数,夹在 2–4 列(规格 §1.1)。
 * 不能沿用 `filmGridColumnCount` —— 那条按 280px 最小卡宽算,整个栏宽范围内
 * 都只会算出 1 列。左栏的卡片本来就该比全宽胶片墙的小。
 */
export function poolColumnCount(paneWidth: number): 2 | 3 | 4 {
  if (paneWidth < 300) return 2;
  if (paneWidth < 420) return 3;
  return 4;
}

function activeRating(value: number | null): number | null {
  return value === 0 ? null : value;
}

export function isSuspectedWaste(clip: ClipListItem): boolean {
  return analysisBadgeKinds(clip).some((kind) => SUSPECT_BADGES.has(kind));
}

export function filterSelectionClips(
  clips: ClipListItem[],
  filter: SelectionFilter,
  excludeSuspect: boolean,
  qualityExemptClipIds: ReadonlySet<number> = new Set(),
): ClipListItem[] {
  return clips.filter((clip) => {
    if (clip.id === null || clip.status !== "ready") return false;
    if (excludeSuspect && isSuspectedWaste(clip) && !qualityExemptClipIds.has(clip.id)) {
      return false;
    }
    const binary = activeRating(clip.binary_rating);
    const star = activeRating(clip.star_rating);
    switch (filter) {
      case "favorite":
        return binary === 1;
      case "unrated":
        return binary === null && star === null;
      case "rejected":
        return binary === -1;
      default:
        return true;
    }
  });
}

export function filterClipsByDimension(
  clips: ClipListItem[],
  dimensions: ClipDimension[],
  dimension: ClipDimensionKey | "",
  label: string,
): ClipListItem[] {
  if (!dimension || !label) return clips;
  const matchingIds = new Set(
    dimensions
      .filter((item) => item.dimension === dimension && item.label === label)
      .map((item) => item.clip_id),
  );
  return clips.filter((clip) => clip.id !== null && matchingIds.has(clip.id));
}

// G4：rotation 与 width/height 都是 ffprobe 探测出的解码前（旋转前）尺寸——
// 90/270 会把 landscape 的解码尺寸转成竖屏画面，反之亦然。用 XOR：
// 已经是竖屏尺寸 且 旋转不是 90/270 → 仍是竖屏；反之同理。
export function isPortraitClip(clip: Pick<ClipListItem, "rotation" | "width" | "height">): boolean {
  const rotatesQuarterTurn = clip.rotation === 90 || clip.rotation === 270;
  const tallerThanWide = (clip.height ?? 0) > (clip.width ?? 0);
  return rotatesQuarterTurn !== tallerThanWide;
}

export function filterClipsByOrientation(
  clips: ClipListItem[],
  orientation: OrientationFilter,
): ClipListItem[] {
  if (orientation === "all") return clips;
  return clips.filter((clip) => isPortraitClip(clip) === (orientation === "portrait"));
}

export function buildShotStackWallItems(
  filteredClips: ClipListItem[],
  allClips: ClipListItem[],
  stacks: ShotStack[],
  hideCandidates: boolean,
  semanticScores: ReadonlyMap<number, number> = new Map(),
): ShotStackWallItem[] {
  const clipsById = new Map(
    allClips
      .filter((clip): clip is ClipListItem & { id: number } => clip.id !== null)
      .map((clip) => [clip.id, clip] as const),
  );
  const filteredIds = new Set(
    filteredClips
      .map((clip) => clip.id)
      .filter((clipId): clipId is number => clipId !== null),
  );
  const stackByClipId = new Map<number, ShotStack>();
  stacks.forEach((stack) => {
    stack.members.forEach((member) => stackByClipId.set(member.clip_id, stack));
  });
  const emitted = new Set<number>();
  const items: ShotStackWallItem[] = [];
  filteredClips.forEach((clip) => {
    if (clip.id === null) return;
    const stack = stackByClipId.get(clip.id);
    if (!stack) {
      items.push({ clip, semanticScore: semanticScores.get(clip.id) });
      return;
    }
    if (emitted.has(stack.id)) return;
    emitted.add(stack.id);
    const preferred =
      stack.members.find((member) => member.is_preferred && filteredIds.has(member.clip_id)) ??
      stack.members.find((member) => filteredIds.has(member.clip_id)) ??
      stack.members[0];
    const hasPreferred = stack.members.some((member) => member.is_preferred);
    const representative = clipsById.get(preferred.clip_id) ?? clip;
    items.push({
      clip: representative,
      stack:
        (hideCandidates && !stack.quality_exempt && hasPreferred) ||
        (stack.members.length === 1 && !stack.quality_exempt && hasPreferred)
          ? undefined
          : stack,
      semanticScore: representative.id === null ? undefined : semanticScores.get(representative.id),
    });
  });
  return items;
}

/** 媒体池卡片上的时长 —— 补零到 mm:ss,规格 §7 的 AX 名靠它对齐。 */
export function poolDurationLabel(clip: ClipListItem): string {
  if (
    clip.duration_ticks === null ||
    clip.tb_num === null ||
    clip.tb_den === null ||
    clip.tb_den <= 0
  ) {
    return "—";
  }
  const total = Math.max(0, Math.round((clip.duration_ticks * clip.tb_num) / clip.tb_den));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

export function poolRatingLabel(clip: ClipListItem): string {
  const binary = activeRating(clip.binary_rating);
  if (binary === 1) return "收藏";
  if (binary === -1) return "拒绝";
  const star = activeRating(clip.star_rating);
  return star === null ? "未评" : `${star} 星`;
}

/**
 * 两行文件名(规格 §3.5):在最接近中点的 `_` 处断(`_` 留在第一行末尾),没有 `_`
 * 就按中点断;第二行永远含扩展名 —— 这是旧 `splitFileName` 「尾部总在」语义的
 * 继承者,但**不再省略任何字符**:两段拼回去就是原名。短于 `maxLine` 的只有一行。
 * 每段自己还可能在 CSS 里再折一次(`overflow-wrap: anywhere`),卡片最多三行。
 */
export function fileNameLines(name: string, maxLine = 18): [string, string | null] {
  if (name.length <= maxLine) return [name, null];
  const mid = name.length / 2;
  let cut = -1;
  for (let index = name.indexOf("_"); index >= 0; index = name.indexOf("_", index + 1)) {
    // 断在最后一个 `_` 之后会把扩展名单独甩成一行,跳过它。
    if (index >= name.length - 1) break;
    if (cut < 0 || Math.abs(index - mid) <= Math.abs(cut - mid)) cut = index;
  }
  const at = cut >= 0 ? cut + 1 : Math.min(maxLine, Math.ceil(mid));
  return [name.slice(0, at), name.slice(at)];
}

/** 拍摄日期:`captured_at` 的 ISO 日期段 → `08-12`;没有就不显示。 */
export function poolDateLabel(clip: ClipListItem): string | null {
  const match = clip.captured_at?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : null;
}

/** 规格 §7:媒体池卡片 `aria-label="{file} · {时长} · {评级}"`,一字不差。 */
export function clipAriaLabel(clip: ClipListItem): string {
  return `${clip.file_name} · ${poolDurationLabel(clip)} · ${poolRatingLabel(clip)}`;
}

export const POOL_FILTER_LABELS: Record<SelectionFilter, string> = {
  all: "全部",
  favorite: "收藏",
  unrated: "未评",
  rejected: "拒绝",
};

export const POOL_DIMENSION_LABELS: Record<ClipDimensionKey, string> = {
  movement: "①运动",
  shot_size: "②景别",
  subject: "③主体",
  viewpoint: "④视角",
  function: "⑤功能",
  person_state: "⑥人物状态",
  time_stage: "⑦时间阶段",
  sound: "⑧声音",
};

export const POOL_DIMENSION_KEYS = Object.keys(POOL_DIMENSION_LABELS) as ClipDimensionKey[];

/**
 * 媒体池的行高 —— 比全宽胶片墙的 260 矮:左栏 260–480 宽、2–4 列,卡片本来
 * 就只有一百多像素宽,再配 260 的行高就全是空白。146 = 卡片 136(16:9 缩略图 ≈ 52
 * + 文件名三行 36 + 元信息 14 + 角标 18 + 内边距与行距)+ 10 行距;卡片高度由行决定。
 */
export const POOL_ROW_HEIGHT = 146;

export function poolRowTop(row: number): number {
  return row * POOL_ROW_HEIGHT;
}

export function poolRowAtOffset(offset: number): number {
  return Math.max(0, Math.floor(offset / POOL_ROW_HEIGHT));
}
