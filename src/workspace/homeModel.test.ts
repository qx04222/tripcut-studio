import { describe, expect, it } from "vitest";

import type { EpisodeSummary } from "../api";
import { HOME_TEMPLATES, episodeProgress, homeVisible, recentEpisodes, templateEpisodeTitle } from "./homeModel";

function episode(patch: Partial<EpisodeSummary>): EpisodeSummary {
  return {
    id: 1,
    title: "EP01",
    theme: "",
    episode_number: 1,
    status: "active",
    created_at: "2026-08-11T20:00:00+08:00",
    archived_at: null,
    clip_count: 0,
    favorite_count: 0,
    export_count: 0,
    target_platform: "general",
    canvas_orientation: "landscape",
    ...patch,
  };
}

/** R13 §3:首页 —— 空库或点 logo 显示;有素材时不再自动出现。 */
describe("homeModel", () => {
  it("首页可见:库空(已读回)自动出;钉住(点 logo)任何时候都出;有素材且没钉住不出;加载中不出", () => {
    expect(homeVisible({ loading: false, clipCount: 0, pinned: false })).toBe(true);
    expect(homeVisible({ loading: true, clipCount: 0, pinned: false })).toBe(false);
    expect(homeVisible({ loading: false, clipCount: 5, pinned: false })).toBe(false);
    expect(homeVisible({ loading: false, clipCount: 5, pinned: true })).toBe(true);
    expect(homeVisible({ loading: true, clipCount: 0, pinned: true })).toBe(true);
  });

  it("最近的集:进行中排最前,其余按创建时间倒序,最多 6 张", () => {
    const list = [
      episode({ id: 1, status: "archived", created_at: "2026-01-01T00:00:00Z" }),
      episode({ id: 2, status: "archived", created_at: "2026-03-01T00:00:00Z" }),
      episode({ id: 3, status: "active", created_at: "2026-02-01T00:00:00Z" }),
      ...[4, 5, 6, 7, 8].map((id) => episode({ id, status: "archived", created_at: `2025-0${id}-01T00:00:00Z` })),
    ];
    const recent = recentEpisodes(list);
    expect(recent.map((item) => item.id)).toEqual([3, 2, 1, 8, 7, 6]);
  });

  it("四步进度:进行中的集用流水线的 done;封存的集由计数推:有素材 / 有收藏 / 导出过(排列也算完成)", () => {
    expect(episodeProgress(episode({ status: "archived", clip_count: 3 }), null)).toEqual([true, false, false, false]);
    expect(episodeProgress(episode({ status: "archived", clip_count: 3, favorite_count: 1 }), null)).toEqual([true, true, false, false]);
    expect(episodeProgress(episode({ status: "archived", clip_count: 3, favorite_count: 1, export_count: 2 }), null)).toEqual([true, true, true, true]);
    expect(episodeProgress(episode({ status: "active", clip_count: 3 }), [true, true, false, false])).toEqual([true, true, false, false]);
  });

  it("三个模板卡:旅行日记 / 电影感 / 快节奏,对应 diary / cinematic / fastcut;标题带日期", () => {
    expect(HOME_TEMPLATES.map((item) => item.label)).toEqual(["旅行日记", "电影感", "快节奏"]);
    expect(HOME_TEMPLATES.map((item) => item.id)).toEqual(["diary", "cinematic", "fastcut"]);
    for (const item of HOME_TEMPLATES) expect(item.blurb).not.toMatch(/tick|时基|VFR|remux|L1|L3|sidecar|Stack|hero/i);
    expect(templateEpisodeTitle(HOME_TEMPLATES[0], new Date("2026-09-14T10:00:00"))).toBe("旅行日记 · 09-14");
  });
});
