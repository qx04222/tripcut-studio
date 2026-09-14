import type { EpisodeSummary, StoryTemplate } from "../api";
import { useEffect } from "react";

import { reportLibraryState, useHomeOpen } from "./homeStore";
import { useClipsFeed } from "./useClipsFeed";

export { homeVisible, type HomeInput } from "./homeStore";

/** 壳用:把 feed 的「库空 / 加载中」报进 homeStore,再读合成后的可见性(顶栏只读 `useHomeOpen`)。 */
export function useHomeVisible(): boolean {
  const feed = useClipsFeed();
  const loading = feed.loading;
  const clipCount = feed.clips.length;
  useEffect(() => {
    reportLibraryState({ loading, clipCount });
  }, [loading, clipCount]);
  return useHomeOpen();
}

/** 首页「最近的集」最多几张卡。 */
export const RECENT_LIMIT = 6;

/** 进行中的集排最前(它就是「继续上次」),其余按创建时间倒序。 */
export function recentEpisodes(list: readonly EpisodeSummary[]): EpisodeSummary[] {
  return [...list]
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "active" ? -1 : 1;
      return right.created_at.localeCompare(left.created_at);
    })
    .slice(0, RECENT_LIMIT);
}

export type StepDone = readonly [boolean, boolean, boolean, boolean];

/**
 * 集卡上的四步进度。进行中的集直接用流水线的 done(与导航条同一套数据);封存的集
 * 没有故事板可查,由集记录的计数推:有素材 = ①、有收藏 = ②、导出过 = ③④(导出必然排过)。
 */
export function episodeProgress(episode: EpisodeSummary, activeDone: StepDone | null): StepDone {
  if (episode.status === "active" && activeDone !== null) return activeDone;
  const exported = episode.export_count > 0;
  return [episode.clip_count > 0, episode.favorite_count > 0 || exported, exported, exported];
}

export interface HomeTemplate {
  id: StoryTemplate;
  label: string;
  blurb: string;
}

/** 三个模板卡(规格 §3)。id 对应后端 `list_story_templates` 的模板 id。 */
export const HOME_TEMPLATES: readonly HomeTemplate[] = [
  { id: "diary", label: "旅行日记", blurb: "按时间顺序讲这一趟,口播和路上的小事都留着。" },
  { id: "cinematic", label: "电影感", blurb: "慢一点、镜头长一点,留白给风景。" },
  { id: "fastcut", label: "快节奏", blurb: "短镜头密集切换,适合发抖音 / 小红书。" },
];

/** 模板新建集的默认集名:「旅行日记 · 09-14」。 */
export function templateEpisodeTitle(template: HomeTemplate, now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${template.label} · ${month}-${day}`;
}

/** 首页记住「预选模板」的设置键(`ui.` 前缀走白名单;镜头带的模板面板据此高亮)。 */
export const TEMPLATE_PRESELECT_KEY = "ui.home.template_preselect";
