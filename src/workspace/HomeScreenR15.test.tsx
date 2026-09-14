// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
  listEpisodes: vi.fn(async () => [] as EpisodeSummary[]),
  createEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
}));
vi.mock("../api", () => apiMocks);
const feedMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedMock.state }));
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

const ACTIVE: EpisodeSummary = {
  id: 2,
  title: "建错的 EP2",
  theme: "",
  episode_number: 2,
  status: "active",
  created_at: "2026-08-12T20:00:00+08:00",
  archived_at: null,
  clip_count: 0,
  favorite_count: 0,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};
const ARCHIVED: EpisodeSummary = { ...ACTIVE, id: 1, title: "EP01 大理", status: "archived", created_at: "2026-08-11T20:00:00+08:00", clip_count: 23 };

import { HomeScreen } from "./HomeScreen";
import { __resetHomeForTests } from "./homeStore";
import { __resetModalStackForTests } from "./modalStack";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

beforeEach(() => {
  __resetHomeForTests();
  __resetWorkspaceForTests();
  __resetModalStackForTests();
  pipelineMock.state = derivePipeline(base);
  feedMock.state = { clips: [], loading: false, episode: { activeId: 2, viewing: null, scopeId: 2, current: ACTIVE } };
  apiMocks.listEpisodes.mockReset().mockResolvedValue([ACTIVE, ARCHIVED]);
  apiMocks.deleteEpisode.mockReset().mockResolvedValue({
    deleted: ACTIVE,
    active: { ...ARCHIVED, status: "active", archived_at: null },
    created_fresh: false,
    removed_clips: 0,
  });
});
afterEach(cleanup);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HomeScreen · R15 集卡片「···」→「删除这一集」", () => {
  it("每张集卡右上角有「集操作 · <标题>」,菜单里有「重命名」「删除这一集」,确认块说原片不会被删", async () => {
    render(<HomeScreen />);
    await settle();
    const list = screen.getByRole("list", { name: "最近的集" });
    await act(async () => {
      within(list).getByRole("button", { name: "集操作 · 建错的 EP2" }).click();
    });
    const menu = screen.getByRole("menu", { name: "集操作 · 建错的 EP2" });
    // R16 P2-3:菜单多了第一项「重命名」;「删除这一集」仍在。
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "删除这一集"]);
    await act(async () => {
      within(menu).getByRole("menuitem", { name: "删除这一集" }).click();
    });
    const confirm = screen.getByRole("alertdialog", { name: "确认删除集" });
    expect(confirm.textContent).toContain("原片不会被删");
    expect(confirm.textContent).toContain("回到「EP01 大理」");
    // 卡片本身仍是一个按钮(「···」不嵌在它里面)。
    expect(within(list).getByRole("button", { name: /^建错的 EP2/ })).toBeTruthy();
  });

  it("确认后调 deleteEpisode、派发 tripcut:episode-changed、卡片列表按新数据刷新,首页留在原地", async () => {
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    render(<HomeScreen />);
    await settle();
    await act(async () => {
      screen.getByRole("button", { name: "集操作 · 建错的 EP2" }).click();
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: "删除这一集" }).click();
    });
    apiMocks.listEpisodes.mockResolvedValue([{ ...ARCHIVED, status: "active", archived_at: null }]);
    await act(async () => {
      within(screen.getByRole("alertdialog", { name: "确认删除集" })).getByRole("button", { name: "删除这一集" }).click();
      await Promise.resolve();
    });
    await settle();
    expect(apiMocks.deleteEpisode).toHaveBeenCalledWith(2);
    expect(changed).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog", { name: "确认删除集" })).toBeNull();
    expect(screen.getByRole("region", { name: "首页" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "集操作 · 建错的 EP2" })).toBeNull();
    expect(screen.getByRole("button", { name: "集操作 · EP01 大理" })).toBeTruthy();
    window.removeEventListener("tripcut:episode-changed", changed);
  });
});
