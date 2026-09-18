import type { PipelineStep } from "./pipelineModel";

/**
 * R19 shell(V-02):顶部不再有「第 n 步提示」那一行。四句提示留下来 —— 进顶栏「下一步」按钮的
 * tooltip(TopBar);首页四步卡的文案由 flow 车道另写。设置键 `pipeline.hint_seen.<n>` 仍在
 * Rust `ONBOARDING_FLAG_KEYS` 白名单里、仍被「重置新手引导」一起清,所以键名函数保留。
 */
export function hintSeenKey(step: PipelineStep): string {
  return `pipeline.hint_seen.${step}`;
}

export const PIPELINE_HINTS: Readonly<Record<PipelineStep, string>> = {
  1: "选一个装着视频的文件夹就行,原片不会被改动;分析在本机跑,不上传。",
  2: "在媒体池按 F 收藏喜欢的、1–5 打星;或直接点右上角「下一步:自动挑选」。",
  3: "挑好的片段排进镜头带后,拖一下镜块就能换顺序;章节有缺口就补一条。",
  4: "点「下一步:导出」,片段会导到你选的文件夹;要整包就切「完整交付包」。",
};
