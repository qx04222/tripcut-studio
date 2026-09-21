import type { ClipListItem, EpisodeSummary } from "../api";
import { featuredPhotos } from "./photoWorkspaceModel";

/**
 * R21 W3(业主拍板「照片的逻辑不应该是视频的那一套」):照片工作台自己的三步流水线,
 * 与视频的四步(`pipelineModel.ts`)是两份独立的纯函数 —— 照片没有「段 / 章 / 镜头带」,
 * 只有 ① 导入(N 张)→ ② 挑选(M 张已选)→ ③ 导出精选照片。
 *
 * | 步 | 完成的定义 |
 * |---|---|
 * | ① 导入 | 照片 ≥1 且没有一张还在排队 / 分析中 |
 * | ② 挑选 | 精选带 ≥1 张(收藏 + ≥3 星 + 擂台 / 自动挑中,与 `featuredPhotos` 同一口径) |
 * | ③ 导出 | 本集导出过至少一次 |
 *
 * 分析中不挡路:有照片就能往 ② 走(分析中也能收藏、打星)。
 */
export type PhotoPipelineStep = 1 | 2 | 3;

export interface PhotoPipelineInput {
  photoCount: number;
  /** 还在排队 / 分析中的照片数。 */
  analysisPending: number;
  /** 精选带里的张数。 */
  selectedCount: number;
  exportCount: number;
}

export interface PhotoPipelineState {
  step: PhotoPipelineStep;
  done: readonly [boolean, boolean, boolean];
  complete: boolean;
  counts: PhotoPipelineInput;
}

export const PHOTO_PIPELINE_STEP_NAMES: Readonly<Record<PhotoPipelineStep, string>> = {
  1: "导入",
  2: "挑选",
  3: "导出精选照片",
};

export const PHOTO_PIPELINE_STEP_MARKS: Readonly<Record<PhotoPipelineStep, string>> = { 1: "①", 2: "②", 3: "③" };

export const PHOTO_PIPELINE_STEPS: readonly PhotoPipelineStep[] = [1, 2, 3];

/** 「下一步」按钮 tooltip 的三句(视频那份在 `pipelineHints.ts`,这里不借)。 */
export const PHOTO_PIPELINE_HINTS: Readonly<Record<PhotoPipelineStep, string>> = {
  1: "选一个装着照片的文件夹就行,原片不会被改动;分析在本机跑,不上传。",
  2: "在照片网格里按 F 收藏、1–5 打星,或在擂台里选出主图;也可以一句话挑照片。",
  3: "点「下一步:导出精选照片」,收藏、3 星以上和擂台选出的照片会按精选带顺序复制到你选的文件夹。",
};

export function derivePhotoPipeline(input: PhotoPipelineInput): PhotoPipelineState {
  const done: [boolean, boolean, boolean] = [
    input.photoCount >= 1 && input.analysisPending === 0,
    input.selectedCount >= 1,
    input.exportCount >= 1,
  ];
  const passable = [input.photoCount >= 1, done[1], done[2]];
  const firstOpen = passable.findIndex((flag) => !flag);
  const step = (firstOpen === -1 ? 3 : firstOpen + 1) as PhotoPipelineStep;
  return { step, done, complete: done.every(Boolean), counts: { ...input } };
}

/** 从 feed 的原始数据拼 `PhotoPipelineInput`(只看 `kind='photo'`)。 */
export function photoPipelineInputFrom(clips: readonly ClipListItem[], episode: EpisodeSummary | null): PhotoPipelineInput {
  const photos = clips.filter((clip) => clip.kind === "photo");
  let analysisPending = 0;
  for (const clip of photos) {
    if (clip.analysis_status === "pending" || clip.analysis_status === "running") analysisPending += 1;
  }
  return {
    photoCount: photos.length,
    analysisPending,
    selectedCount: featuredPhotos(photos, []).length,
    exportCount: episode?.photo_export_count ?? 0,
  };
}

/** 导航条每步右侧的计数短语:「60 张」/「40/60 张」/「10 张已选」/「2 次」。 */
export function photoPipelineStepCount(state: PhotoPipelineState, step: PhotoPipelineStep): string {
  const { counts } = state;
  switch (step) {
    case 1:
      if (counts.photoCount === 0) return "";
      return counts.analysisPending > 0 ? `${counts.photoCount - counts.analysisPending}/${counts.photoCount} 张` : `${counts.photoCount} 张`;
    case 2:
      return counts.selectedCount > 0 ? `${counts.selectedCount} 张已选` : "";
    case 3:
      return counts.exportCount > 0 ? `${counts.exportCount} 次` : "";
  }
}

/** 顶栏主按钮的文案;三步全完成 → 「再导出一次」。分析中不挡路(照片不需要分析完才能挑)。 */
export function photoPipelineNextLabel(state: PhotoPipelineState): string {
  if (state.complete) return "再导出一次";
  switch (state.step) {
    case 1:
      return "下一步:导入照片";
    case 2:
      return "下一步:挑选照片";
    case 3:
      return "下一步:导出精选照片";
  }
}
