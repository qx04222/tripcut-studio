import type { BandSegment } from "./bandSegmentTypes";
export type { BandSegment } from "./bandSegmentTypes";
import { poolCapturedAt } from "./poolOrder";
import type {
  ClipListItem,
  NarrativeBeat,
  ShotStack,
  ShotStackMember,
  StoryGap,
  StoryItem,
  Storyboard,
} from "../api";
import type { BandMode } from "./WorkspaceStore";
/**
 * 镜头带的纯数据层(规格 §3.3)。组件只负责画,分组、序号、缺口白名单、虚拟化
 * 窗口全在这里算完 —— 这几条规则每一条都有测试盯着,搬进 JSX 里就没人看得见了。
 */
/**
 * 可生成槽位白名单,与 `src-tauri/src/core/story_gap.rs:27` 的 `GENERATABLE_SLOTS`
 * 同一份。后端 `detect_story_gaps` 本就只按这张表建缺口行,这里再挡一道是因为
 * 库里可能留着旧版本写下的行 —— 「DH INTRO」「MAP」这类槽位没有可生成的语义,
 * 一旦漏进来就会给出一个按了没反应的「生成候选」按钮(R7 规则不变)。
 */
export const GENERATABLE_SLOTS: readonly string[] = [
  "REAL/ESTABLISHING",
  "REAL/DETAIL",
  "ATMOSPHERE",
  "TRANSITION",
];
/** 缺口还「活着」——已忽略与已填补的不占带上的位置。 */
const ACTIVE_GAP_STATUSES: readonly StoryGap["status"][] = ["open", "requested"];
/** 秒数一位小数,整数不带 .0(「0.5」「3」);R13 的裁剪时长标签(bandTimeline)用同一个格式。 */
export const secondsLabel = (seconds: number): string => (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, ""));
/** 「片段 0.5–4.5 s」—— 按素材自己的 time base 换算(R-02);tb 不合法时只剩「片段」。 */
export function segmentRangeLabel(inTicks: number, outTicks: number, tbNum: number, tbDen: number): string {
  if (tbNum <= 0 || tbDen <= 0) return "片段";
  const toSeconds = (ticks: number) => Math.round((ticks * tbNum * 10) / tbDen) / 10;
  return `片段 ${secondsLabel(toSeconds(inTicks))}–${secondsLabel(toSeconds(outTicks))} s`;
}
/**
 * 一个分段在镜头带上占的像素宽(140px 瓦片 + 8px 间距)。章节偏移、虚拟化窗口与
 * 音乐刻度轨的序号轴都按它算 —— 三处必须是同一个数,刻度才真的落在镜头上。
 * R19 V-06:镜块由 160×130(节距 168)收成 140×112(节距 148);CSS 侧的实宽 / 高在
 * `band-r19.css` 同步改,`bandTimeline.ts` 的 BAND_TILE_WIDTH = 节距 − 8。
 */
export const BAND_SEGMENT_PITCH = 148;
/** 瓦片 140 × 112(R9 规格 §3.7 的 160 × 130,R19 V-06 收小)。 */
export const BAND_TILE_HEIGHT = 112;
/** 章节头一行(`Toolbar dense`,28px)。 */
export const BAND_CHAPTER_HEAD_HEIGHT = 28;
/** 常显横向滚动条的高度。 */
export const BAND_SCROLLBAR_HEIGHT = 10;
/** 视口上下 padding 之和(8 + 8)。 */
export const BAND_VIEWPORT_PADDING = 16;
/**
 * 镜头带视口的**内容高**:章节头 + 瓦片 + 滚动条 + padding = 166(R19 前 184)。视口高度就钉在这个
 * 数上,中栏再高也不会在瓦片下方留出一片白(规格 §3.7);多出的高度归监视器。
 */
export const BAND_VIEWPORT_HEIGHT =
  BAND_CHAPTER_HEAD_HEIGHT + BAND_TILE_HEIGHT + BAND_SCROLLBAR_HEIGHT + BAND_VIEWPORT_PADDING;
/** 附属带(音乐 / 旅程 / 地点卡 / 模板)展开时至少要给它的高度。 */
const BAND_ACCESSORY_MIN_HEIGHT = 100;
/**
 * 镜头带栏的最小高(喂 `WorkspaceShell` 的 `Panel minSize`):故事模式就是视口内容高 184,
 * 附属带展开时再加一段 = 284。中栏纵向分隔条拖到底就是内容高。
 */
export function bandMinHeight(mode: BandMode): number {
  return mode === "story" ? BAND_VIEWPORT_HEIGHT : BAND_VIEWPORT_HEIGHT + BAND_ACCESSORY_MIN_HEIGHT;
}
/** 栏标题条(`PaneHead`,套件 `--pane` 32px)——它也在镜头带那个 Panel 里。 */
export const BAND_PANE_HEAD_HEIGHT = 32;
/** 音乐模式插在带上方的刻度轨(`MusicRuler.MUSIC_RULER_HEIGHT`,那边的测试钉住两者相等)。 */
export const BAND_MUSIC_RULER_HEIGHT = 36;
/**
 * `WorkspaceShell` 那个 Panel 的最小高 = 栏标题条 + `bandMinHeight`(故事 216,附属 316),
 * 音乐模式再加刻度轨 36 = 352 —— 少算它,附属区就被刻度轨挤掉一截。
 */
export function bandPanelMinHeight(mode: BandMode): number {
  return BAND_PANE_HEAD_HEIGHT + (mode === "music" ? BAND_MUSIC_RULER_HEIGHT : 0) + bandMinHeight(mode);
}
/**
 * 镜头带栏的**实际**高(`WorkspaceShell` 用它 `resize` 那个 Panel):
 * - 故事模式跟着内容走(标题条 + 视口 + 可能展开的 Take 条 / toast),再高瓦片下方也只会多出
 *   一片壳底色,所以多出的全归监视器;内容高还没量到(0)时退到 min。
 * - 附属模式按持久化的监视器占比分剩余给带,但不低于 min;栈高拿不到时退到 min。
 */
export function bandPanelHeight(
  mode: BandMode,
  measure: { stackHeight: number; monitorRatio: number; contentHeight: number },
): number {
  const min = bandPanelMinHeight(mode);
  if (mode === "story") return Math.max(min, Math.round(measure.contentHeight));
  if (measure.stackHeight <= 0) return min;
  return Math.max(min, Math.round(measure.stackHeight * (1 - measure.monitorRatio)));
}
/** C 稿的镜头带视图切换:按章节(默认)/ 按时间(平坦序列)/ 仅缺口(只留有缺口的章)。 */
export type BandView = "chapter" | "time" | "gaps";
export const BAND_VIEWS: readonly { view: BandView; label: string }[] = [
  { view: "chapter", label: "按章节" },
  { view: "time", label: "按时间" },
  { view: "gaps", label: "仅缺口" },
];
const BEAT_ROLE_LABELS: Record<NarrativeBeat["role"], string> = {
  beat: "叙事",
  montage: "蒙太奇",
  transition: "过渡",
};
function beatRoleByClip(board: Storyboard): ReadonlyMap<number, string> {
  const roles = new Map<number, string>();
  for (const chapter of board.narrative?.chapters ?? []) {
    for (const beat of chapter.beats ?? []) roles.set(beat.clip_id, BEAT_ROLE_LABELS[beat.role] ?? beat.role);
  }
  return roles;
}
export interface BandChapter {
  /** 章在故事板里的 1 基序号;仅缺口视图过滤掉一些章之后,留下的章仍报自己原来的号。 */
  ordinal: number;
  chapterId: number | null;
  title: string;
  /** 章内各段按各自 time base 换算后的毫秒总和——各段 tb 不同,ticks 不能直接相加(R-02)。 */
  durationMs: number;
  /** 活着的空槽位数;**0 镜的章本身也算一处缺口**(R10 U-17,「仅缺口」视图靠它留下空章)。 */
  gapCount: number;
  /** 真实镜头数(不含空槽位);带头「n 镜 · m 缺口」分列(R10 U-29)。 */
  clipCount: number;
  /** 连空槽位都没有。 */
  isEmpty: boolean;
  /** R12 §2「这章够了」:被标成跳过的章,0 镜也不算缺口。 */
  skipped: boolean;
  segments: BandSegment[];
}
/** 没有章节归属的素材落在这一桶里,永远排在最后(与 Storyboard.tsx 的 UNCHAPTERED 同语义)。 */
const UNCHAPTERED_TITLE = "未分章";
const itemDurationTicks = (item: StoryItem): number => Math.max(0, item.out_ticks - item.in_ticks);
/** 分段时长换算成毫秒;tb 不合法(旧后端 0/负数)按 0 计,不让一条坏数据把章节时长算成 NaN。 */
export const segmentDurationMs = (segment: Pick<BandSegment, "durationTicks" | "tbNum" | "tbDen">): number =>
  segment.tbNum > 0 && segment.tbDen > 0 ? (segment.durationTicks * segment.tbNum * 1_000) / segment.tbDen : 0;
function orderItems(items: readonly StoryItem[]): StoryItem[] {
  return [...items].sort(
    (left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
      left.key.localeCompare(right.key),
  );
}
// 缺口挂在镜头带哪一章看后端算好的 D2 章 id(band_chapter_id),null / 缺席(旧后端)才回落叙事章 id—— chapter_id 是 narrative_chapters.id,与 D2 chapters.id 相等只是巧合,不能直接比。
function activeGapsFor(gaps: readonly StoryGap[], chapterId: number | null): StoryGap[] {
  if (chapterId === null) return [];
  return gaps.filter(
    (gap) =>
      (gap.band_chapter_id ?? gap.chapter_id) === chapterId &&
      ACTIVE_GAP_STATUSES.includes(gap.status) &&
      GENERATABLE_SLOTS.includes(gap.slot),
  );
}
/**
 * Take 列表的展示顺序:真实素材在前,生成片永远在后(R7 §6),组内保持 Stack 自己的顺序 ——
 * 那就是 best-take 的结论,不该在前端二次排序。带上的「Take n/m」与 Take 条按同一份顺序数。
 */
export function orderedTakes(
  stack: ShotStack,
  clipsById: ReadonlyMap<number, ClipListItem>,
): ShotStackMember[] {
  const real: ShotStackMember[] = [];
  const generated: ShotStackMember[] = [];
  for (const member of stack.members ?? []) {
    (clipsById.get(member.clip_id)?.generated_source ? generated : real).push(member);
  }
  return [...real, ...generated];
}
function stackForClip(stacks: readonly ShotStack[], clipId: number): ShotStack | null {
  for (const stack of stacks) {
    if (stack.members?.some((member) => member.clip_id === clipId)) return stack;
  }
  return null;
}
/**
 * 章节分组 + 全带连续序号。空槽位排在本章真实分段之后 —— 缺口是「这一章还差
 * 什么」,不是时间轴上的某一刻,插在中间只会让拖排的落点含义不明。
 */
export function buildBandChapters(
  board: Storyboard,
  gaps: readonly StoryGap[],
  stacks: readonly ShotStack[],
  clipsById: ReadonlyMap<number, ClipListItem>,
  /** R12:「这章够了」标过的章 id(settings `story.chapter_skipped.<id>` = "true")。 */
  skippedChapters: ReadonlySet<number> = new Set(),
): BandChapter[] {
  const boardChapters = board.chapters ?? [];
  const boardItems = (board.items ?? []).filter((item) => clipsById.get(item.clip_id)?.kind === "video");
  const buckets: { chapterId: number | null; title: string }[] = boardChapters.map((chapter) => ({
    chapterId: chapter.id,
    title: chapter.title,
  }));
  if (boardItems.some((item) => item.chapter_id === null)) {
    buckets.push({ chapterId: null, title: UNCHAPTERED_TITLE });
  }
  const roles = beatRoleByClip(board);
  let index = 0;
  return buckets.map((bucket, bucketIndex) => {
    const segments: BandSegment[] = [];
    for (const item of orderItems(boardItems.filter((i) => i.chapter_id === bucket.chapterId))) {
      const stack = stackForClip(stacks, item.clip_id);
      index += 1;
      segments.push({
        key: item.key,
        kind: "clip",
        mediaKind: "video",
        index,
        clipId: item.clip_id,
        segmentId: item.segment_id,
        chapterId: item.chapter_id,
        slot: null,
        fileName: item.file_name,
        inTicks: item.in_ticks,
        outTicks: item.out_ticks,
        durationTicks: itemDurationTicks(item),
        tbNum: item.tb_num,
        tbDen: item.tb_den,
        // Stack 之外的素材就是它自己一条 Take —— 0 会让角标说「0 条候选」。
        takeCount: stack ? stack.members.length : 1,
        takeIndex: stack
          ? Math.max(0, orderedTakes(stack, clipsById).findIndex((member) => member.clip_id === item.clip_id)) + 1
          : 1,
        isGenerated: Boolean(clipsById.get(item.clip_id)?.generated_source),
        coverUrl: clipsById.get(item.clip_id)?.cover_url ?? null,
        gap: null,
        slotIndex: segments.length + 1,
        roleLabel: roles.get(item.clip_id) ?? null,
        rangeLabel: item.segment_id === null ? null : segmentRangeLabel(item.in_ticks, item.out_ticks, item.tb_num, item.tb_den),
      });
    }
    const chapterGaps = activeGapsFor(gaps, bucket.chapterId);
    for (const gap of chapterGaps) {
      index += 1;
      segments.push({
        key: `slot:${gap.chapter_id}:${gap.slot}`,
        kind: "slot",
        index,
        clipId: null,
        segmentId: null,
        chapterId: gap.chapter_id,
        slot: gap.slot,
        fileName: null,
        inTicks: 0,
        outTicks: 0,
        durationTicks: 0,
        tbNum: 1,
        tbDen: 1_000,
        takeCount: 0,
        takeIndex: 0,
        isGenerated: false,
        coverUrl: null,
        gap,
        slotIndex: segments.length + 1,
        roleLabel: null,
        rangeLabel: null,
      });
    }
    const isEmpty = segments.length === 0;
    const skipped = bucket.chapterId !== null && skippedChapters.has(bucket.chapterId);
    return {
      ordinal: bucketIndex + 1,
      chapterId: bucket.chapterId,
      title: bucket.title,
      durationMs: segments.reduce((sum, segment) => sum + segmentDurationMs(segment), 0),
      // 「这章够了」的 0 镜章不算缺口(R12 §2);已有槽位缺口照算。
      gapCount: chapterGaps.length + (isEmpty && !skipped ? 1 : 0),
      clipCount: segments.length - chapterGaps.length,
      isEmpty,
      skipped,
      segments,
    };
  });
}
/** 带头与栏标题条的计数:「n 镜 · m 缺口」,没缺口时只有「n 镜」(R10 U-29)。 */
export const bandCountLabel = (clipCount: number, gapCount: number): string =>
  gapCount > 0 ? `${clipCount} 镜 · ${gapCount} 缺口` : `${clipCount} 镜`;
const TIME_VIEW_TITLE = "按时间";
/**
 * 视图切换是纯函数:按章节原样返回(同一引用,组件的 memo 不白算);仅缺口只留
 * `gapCount > 0` 的章;按时间把所有真实分段铺成一条按 `captured_at` 升序的序列
 * (没有拍摄时间的按原序排在最后),空槽位不进时间轴 —— 缺口不是时间上的某一刻。
 */
export function applyBandView(
  chapters: readonly BandChapter[],
  view: BandView,
  clipsById?: ReadonlyMap<number, ClipListItem>,
): readonly BandChapter[] {
  if (view === "chapter") return chapters;
  if (view === "gaps") return chapters.filter((chapter) => chapter.gapCount > 0);
  const capturedAt = (segment: BandSegment): string | null =>
    segment.clipId === null ? null : (clipsById?.get(segment.clipId) ? poolCapturedAt(clipsById.get(segment.clipId)!) : null);
  const clips = chapters.flatMap((chapter) => chapter.segments.filter((segment) => segment.kind === "clip"));
  const timed = clips.filter((segment) => capturedAt(segment) !== null);
  const untimed = clips.filter((segment) => capturedAt(segment) === null);
  timed.sort((left, right) => capturedAt(left)!.localeCompare(capturedAt(right)!));
  const segments = [...timed, ...untimed].map((segment, position) => ({
    ...segment,
    index: position + 1,
    slotIndex: position + 1,
  }));
  return [
    {
      ordinal: 1,
      chapterId: null,
      title: TIME_VIEW_TITLE,
      durationMs: segments.reduce((sum, segment) => sum + segmentDurationMs(segment), 0),
      gapCount: 0,
      clipCount: segments.length,
      isEmpty: segments.length === 0,
      skipped: false,
      segments,
    },
  ];
}
/** 规格 §7 冻结的 AX 名,一字不差。 */
export function segmentAriaLabel(segment: BandSegment): string {
  if (segment.kind === "slot") {
    return `镜头 ${segment.index}：缺口 ${segment.gap ? slotLabelZh(segment.gap) : segment.slot ?? ""}`;
  }
  return `镜头 ${segment.index}：${segment.fileName ?? ""}`;
}
/** 直接取 `gap.slot_label_zh`,不在前端重造映射(后端 story_gap.rs 才是那张表的家)。 */
export function slotLabelZh(gap: StoryGap): string {
  return gap.slot_label_zh;
}
function clampIndex(value: number, total: number): number {
  return Math.min(Math.max(0, value), Math.max(0, total - 1));
}
function inclusiveRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let index = from; index <= to; index += 1) out.push(index);
  return out;
}
/**
 * 视口外的章节只渲染带头;拖动期间**放宽**虚拟化而不是关掉(规格 §11,V14-02 修正;R22-C 再修)。
 *
 * V14-02 的教训:以前拖动只留「当前章 ±1」,`active` 取的是视口最左那章,视口装得下 7 章时,
 * 离左缘 ≥2 章的源章一拖起就被折叠成「n 个镜头」,连源都没了、更没有落点(真机:7 章 · 11 镜,
 * 第 7 章内拖排松手无效)。当时的修法是拖动期间所有章全渲染 —— 在几十镜上画得起,但 R22-C 的
 * 300 段夹具上 dnd-kit 每次指针移动都要对 300 个 sortable 重算 → 5 s 拖动掉帧 46%。
 *
 * 现在拖动时按**真实 scrollLeft** 取视口,前后各留一屏余量(dnd-kit 的落点可能在视口边缘之外几十
 * 像素;栏边缘自动滚动会推着 scrollLeft 走,窗口跟着挪),再无条件保留**源章**(`sourceChapter`,
 * 拖起的那块所在章;它卸载了 dnd-kit 就会取消这次拖动)。折叠章仍是一个可落的目标(整章卡)。
 */
export function renderableChapterRange(
  scrollLeftByChapter: readonly number[],
  viewportWidth: number,
  activeChapterIndex: number,
  dragging: boolean,
  /**
   * 视口真实的 scrollLeft。省略时退回「当前章的起点」—— 但那只在滚动位置恰好落在
   * 章节起点时才对:滚到一个长章的中段,按章起点算一个视口宽,下一章还在
   * 「视口之外」,右半屏只剩一张折叠卡(R8 设计轮实测)。
   */
  scrollLeft?: number,
  /** 拖动源所在章的下标;拖动期间无条件全渲染(越界 / 省略则忽略)。 */
  sourceChapter?: number,
  /**
   * 整条带的内容宽(最后一个 span 的右缘)。没滚动过时「起点 = 选中章的偏移」要被它钳住:
   * 浏览器根本滚不到那么远(内容比视口窄时滚动位置永远是 0),按选中章算会把它前面的章全折成
   * 「n 个镜头」—— R22-C 真机:9 镜装得下 1500 宽,点第 4 章一块,第 1–3 章立刻折叠(F-R22C-08)。
   */
  contentWidth?: number,
): { from: number; to: number; fullyRendered: readonly number[] } {
  const total = scrollLeftByChapter.length;
  if (total === 0) return { from: 0, to: -1, fullyRendered: [] };
  const active = clampIndex(activeChapterIndex, total);
  const margin = dragging ? Math.max(0, viewportWidth) : 0;
  const maxScroll = contentWidth === undefined ? Number.POSITIVE_INFINITY : Math.max(0, contentWidth - Math.max(0, viewportWidth));
  const start = (scrollLeft ?? Math.min(scrollLeftByChapter[active] ?? 0, maxScroll)) - margin;
  const end = start + Math.max(0, viewportWidth) + margin * 2;
  let from = active;
  for (let index = 0; index < total; index += 1) {
    const chapterEnd = scrollLeftByChapter[index + 1] ?? Number.POSITIVE_INFINITY;
    if (chapterEnd > start) {
      from = index;
      break;
    }
  }
  let to = from;
  for (let index = from; index < total; index += 1) {
    if ((scrollLeftByChapter[index] ?? 0) < end) to = index;
  }
  const fullyRendered = inclusiveRange(from, to);
  if (dragging && sourceChapter !== undefined && sourceChapter >= 0 && sourceChapter < total && !fullyRendered.includes(sourceChapter)) {
    fullyRendered.push(sourceChapter);
    fullyRendered.sort((a, b) => a - b);
  }
  return { from, to, fullyRendered };
}
