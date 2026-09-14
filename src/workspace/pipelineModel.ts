import type { ClipListItem, EpisodeSummary, Storyboard } from "../api";

/**
 * R12 §0:四步流水线的状态**全部由数据推导**,不靠用户点「完成」。
 *
 * | 步 | 完成的定义 |
 * |---|---|
 * | ① 导入 | 素材 ≥1 且没有一条还在排队 / 分析中 |
 * | ② 挑选 | 精选段 ≥1(`select_count` 之和) |
 * | ③ 排列 | 有章节,且每章 ≥1 镜或被用户标成「这章够了」 |
 * | ④ 导出 | 本集导出过至少一次 |
 *
 * 当前步 = 第一个没完成的步;四步都完成时停在 ④(主按钮变「再导出一次」)。
 * 唯一的例外:素材还在分析时 ① 不打勾,但**不挡路** —— 有素材就能往 ② 走(分析中也能收藏、
 * 自动挑选),导航条上 ① 显示「58/60 条」告诉用户还没分析完。新手不该被一颗禁用的主按钮困住。
 * 这里只有纯函数,壳 / 导航条 / 空态 / 首启卡都读同一份 `PipelineState`。
 */
export type PipelineStep = 1 | 2 | 3 | 4;

export interface PipelineChapter {
  id: number;
  shotCount: number;
}

export interface PipelineInput {
  clipCount: number;
  /** 还在排队 / 分析中的素材数(pending + running)。 */
  analysisPending: number;
  segmentCount: number;
  chapters: readonly PipelineChapter[];
  /** 车道 B「这章够了」标记的章 id;缺省空集。 */
  skippedChapterIds?: ReadonlySet<number>;
  exportCount: number;
  /**
   * Z-03:还没排进镜头带的精选(storyboard.candidates);缺省 = 不知道(不走捷径)。段全排进去了、却还有章是空的,
   * ③ 视为「够往下走」—— 否则「下一步:排到镜头带」按了没东西可排,成了死点。
   */
  unplacedCount?: number;
}

export interface PipelineCounts {
  clips: number;
  analysisPending: number;
  segments: number;
  /** 已有镜(或被跳过)的章数 / 总章数。 */
  chaptersFilled: number;
  chaptersTotal: number;
  exports: number;
  /** Z-03:没镜也没被「这章够了」的章数(次要动作「补缺口」用)。 */
  openChapters: number;
}

export interface PipelineState {
  step: PipelineStep;
  done: readonly [boolean, boolean, boolean, boolean];
  /** 四步全完成:主按钮「再导出一次」。 */
  complete: boolean;
  counts: PipelineCounts;
}

export const PIPELINE_STEP_NAMES: Readonly<Record<PipelineStep, string>> = {
  1: "导入",
  2: "挑选",
  3: "排列",
  4: "导出",
};

/** 全角带圈数字,只做视觉;AX 名用「第 n 步」。 */
export const PIPELINE_STEP_MARKS: Readonly<Record<PipelineStep, string>> = { 1: "①", 2: "②", 3: "③", 4: "④" };

export const PIPELINE_STEPS: readonly PipelineStep[] = [1, 2, 3, 4];

export function derivePipeline(input: PipelineInput): PipelineState {
  const skipped = input.skippedChapterIds ?? new Set<number>();
  const chaptersFilled = input.chapters.filter((chapter) => chapter.shotCount >= 1 || skipped.has(chapter.id)).length;
  const openChapters = input.chapters.length - chaptersFilled;
  // Z-03:每章都有镜(或被跳过)= 完成;段全排进去了、至少一章有镜 = 也算完成(缺口另给「补缺口」)。
  // `unplacedCount` 缺省(旧调用方 / 没有镜头带数据)= 不知道 → 不走这条捷径。
  const allPlaced = input.unplacedCount === 0 && chaptersFilled >= 1;
  const done: [boolean, boolean, boolean, boolean] = [
    input.clipCount >= 1 && input.analysisPending === 0,
    input.segmentCount >= 1,
    input.chapters.length >= 1 && (chaptersFilled === input.chapters.length || allPlaced),
    input.exportCount >= 1,
  ];
  const passable = [input.clipCount >= 1, done[1], done[2], done[3]];
  const firstOpen = passable.findIndex((flag) => !flag);
  const step = (firstOpen === -1 ? 4 : firstOpen + 1) as PipelineStep;
  return {
    step,
    done,
    complete: done.every(Boolean),
    counts: {
      clips: input.clipCount,
      analysisPending: input.analysisPending,
      segments: input.segmentCount,
      chaptersFilled,
      chaptersTotal: input.chapters.length,
      exports: input.exportCount,
      openChapters,
    },
  };
}

/** 从 feed 的原始数据拼 `PipelineInput`(壳的 hook 与首启卡都走这一条,免得两处各算一份)。 */
export function pipelineInputFrom(
  clips: readonly ClipListItem[],
  storyboard: Storyboard | null,
  episode: EpisodeSummary | null,
  skippedChapterIds?: ReadonlySet<number>,
): PipelineInput {
  let analysisPending = 0;
  let segmentCount = 0;
  for (const clip of clips) {
    if (clip.analysis_status === "pending" || clip.analysis_status === "running") analysisPending += 1;
    segmentCount += clip.select_count ?? 0;
  }
  const shotsByChapter = new Map<number, number>();
  for (const item of storyboard?.items ?? []) {
    if (item.chapter_id === null) continue;
    shotsByChapter.set(item.chapter_id, (shotsByChapter.get(item.chapter_id) ?? 0) + 1);
  }
  return {
    clipCount: clips.length,
    analysisPending,
    segmentCount,
    chapters: (storyboard?.chapters ?? []).map((chapter) => ({ id: chapter.id, shotCount: shotsByChapter.get(chapter.id) ?? 0 })),
    skippedChapterIds,
    exportCount: episode?.export_count ?? 0,
    unplacedCount: storyboard?.candidates?.length ?? 0,
  };
}

/** Z-03:次要动作「补缺口 n 章」的文案;没有缺口或还没走到 ④ 时不显示(null)。 */
export function pipelineGapLabel(state: PipelineState): string | null {
  if (state.step < 4 || state.counts.openChapters <= 0) return null;
  return `补缺口 ${state.counts.openChapters} 章`;
}

/** 导航条每步右侧的计数短语(规格 §1:「导入 21 条 → 挑选 4 段 → 排列 0/2 章 → 导出」)。 */
export function pipelineStepCount(state: PipelineState, step: PipelineStep): string {
  const { counts } = state;
  switch (step) {
    case 1:
      if (counts.clips === 0) return "";
      return counts.analysisPending > 0 ? `${counts.clips - counts.analysisPending}/${counts.clips} 条` : `${counts.clips} 条`;
    case 2:
      return counts.segments > 0 ? `${counts.segments} 段` : "";
    case 3:
      return counts.chaptersTotal > 0 ? `${counts.chaptersFilled}/${counts.chaptersTotal} 章` : "";
    case 4:
      return counts.exports > 0 ? `${counts.exports} 次` : "";
  }
}

/** 顶栏主按钮的文案(规格 §1 第二条);四步全完成 → 「再导出一次」。 */
export function pipelineNextLabel(state: PipelineState): string {
  if (state.complete) return "再导出一次";
  switch (state.step) {
    case 1:
      return "下一步:导入素材";
    case 2:
      return "下一步:自动挑选";
    case 3:
      return "下一步:排到镜头带";
    case 4:
      return "下一步:导出";
  }
}
