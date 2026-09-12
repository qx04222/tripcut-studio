import { BAND_SEGMENT_PITCH, type BandChapter } from "./shotBandModel";

/**
 * 镜头带横轴几何:一章占几个节距、实宽多少、每章从哪个像素开始。
 * 从 shotBandModel 拆出来(那份已到 400 行),三处消费者(章节 section 宽、
 * 虚拟化窗口、音乐刻度轨)必须用同一套数。
 */

/** 章节带头在瓦片**上方**那一行,横向不占宽;章节之间只隔一条与分段间距同宽的缝。 */
export const BAND_CHAPTER_HEADER_WIDTH = 0;

/**
 * 一章在横轴上占几个节距:至少 1 —— 空章要放一张「本章还没有镜头」占位瓦片,
 * 0 宽的章会让相邻两条带头叠在同一位置(R9 实机 D2:2 章 0 镜时 01/02 重影)。
 */
export function chapterPitchCount(chapter: Pick<BandChapter, "segments">): number {
  return Math.max(1, chapter.segments.length);
}

/** 一章的实宽:节距数 × 节距,减掉最后一格的 8px 间距(章与章之间由视口 gap 补)。 */
export function chapterWidth(chapter: Pick<BandChapter, "segments">): number {
  return chapterPitchCount(chapter) * BAND_SEGMENT_PITCH - 8;
}

export function chapterOffsets(chapters: readonly BandChapter[]): number[] {
  const offsets: number[] = [];
  let left = 0;
  for (const chapter of chapters) {
    offsets.push(left);
    left += BAND_CHAPTER_HEADER_WIDTH + chapterPitchCount(chapter) * BAND_SEGMENT_PITCH;
  }
  return offsets;
}

