// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
  listEpisodes: vi.fn(async () => [] as EpisodeSummary[]),
  createEpisode: vi.fn(async (title: string) => ({ episode: { ...ACTIVE, id: 9, title, clip_count: 0 }, reused_empty: true, archived: null })),
}));
vi.mock("../api", () => apiMocks);
const feedMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedMock.state }));
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

const ACTIVE: EpisodeSummary = {
  id: 1,
  title: "EP01 大理",
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
};
const ARCHIVED: EpisodeSummary = { ...ACTIVE, id: 0, title: "EP00 试拍", status: "archived", clip_count: 23, favorite_count: 4, export_count: 1 };

import { HomeScreen } from "./HomeScreen";
import { __resetHomeForTests, isHomePinned, pinHome } from "./homeStore";
import { __resetModalStackForTests, isPlayerOccluded } from "./modalStack";
import { derivePipeline, type PipelineInput } from "./pipelineModel";
import { __resetWorkspaceForTests, getWorkspaceSnapshot } from "./WorkspaceStore";

const base: PipelineInput = { clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 };

function feed(patch: Record<string, unknown> = {}) {
  return { clips: [], loading: false, episode: { activeId: 1, viewing: null, scopeId: 1, current: ACTIVE }, ...patch };
}

beforeEach(() => {
  __resetHomeForTests();
  __resetWorkspaceForTests();
  __resetModalStackForTests();
  pipelineMock.state = derivePipeline(base);
  feedMock.state = feed();
  apiMocks.listEpisodes.mockReset().mockResolvedValue([ACTIVE, ARCHIVED]);
  apiMocks.setSetting.mockReset().mockResolvedValue(undefined);
  apiMocks.createEpisode.mockClear();
});
afterEach(cleanup);

/** R13 §3:首页 —— 「开始一个新旅程」大按钮、最近的集、三个模板卡、R12 四步卡并入顶部。 */
describe("HomeScreen", () => {
  it("region「首页」;四步卡在顶部(与流水线同一套数据);唯一的 primary 是「开始一个新旅程」= 打开导入抽屉", async () => {
    pinHome(true);
    render(<HomeScreen />);
    const home = screen.getByRole("region", { name: "首页" });
    const steps = within(home).getByRole("group", { name: "四步上手" });
    expect(steps.querySelectorAll("li")).toHaveLength(4);
    expect(steps.querySelector("li[aria-current='step']")?.textContent).toContain("导入");
    expect(home.querySelectorAll(".ui-button--primary")).toHaveLength(1);
    const start = within(home).getByRole("button", { name: "开始一个新旅程" });
    expect(start.className).toContain("ui-button--primary");
    await screen.findByText("EP00 试拍");
    act(() => start.click());
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(getWorkspaceSnapshot().importTab).toBe("source");
    expect(isHomePinned()).toBe(false);
    expect(home.textContent).not.toMatch(/tick|时基|VFR|remux|L1|L3|sidecar|Stack|hero/i);
  });

  it("最近的集:进行中在前带「进行中」,封存的带四步进度;点封存的集 = 只读查看并进工作区,点进行中的集 = 进工作区", async () => {
    pinHome(true);
    render(<HomeScreen />);
    const list = await screen.findByRole("list", { name: "最近的集" });
    const cards = within(list).getAllByRole("button");
    expect(cards[0].textContent).toContain("EP01 大理");
    expect(cards[0].textContent).toContain("进行中");
    expect(cards[1].textContent).toContain("EP00 试拍");
    expect(cards[1].querySelectorAll("[data-step-done='true']")).toHaveLength(4);
    const viewed = vi.fn();
    window.addEventListener("tripcut:view-episode", viewed);
    act(() => cards[1].click());
    expect(viewed).toHaveBeenCalledTimes(1);
    expect((viewed.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: 0, title: "EP00 试拍" });
    expect(isHomePinned()).toBe(false);
    pinHome(true);
    act(() => cards[0].click());
    expect(viewed).toHaveBeenCalledTimes(1);
    expect(isHomePinned()).toBe(false);
  });

  it("模板卡三张;当前集为空时点「电影感」= 新建集(就地改名)+ 预选模板 + 镜头带切到模板 + 打开导入抽屉", async () => {
    render(<HomeScreen />);
    const templates = screen.getByRole("group", { name: "从模板开始" });
    const cards = within(templates).getAllByRole("button");
    expect(cards.map((card) => card.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("旅行日记"), expect.stringContaining("电影感"), expect.stringContaining("快节奏")]));
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    await act(async () => {
      within(templates).getByRole("button", { name: /电影感/ }).click();
    });
    await waitFor(() => expect(apiMocks.createEpisode).toHaveBeenCalledTimes(1));
    expect(apiMocks.createEpisode.mock.calls[0][0]).toMatch(/^电影感 · \d{2}-\d{2}$/);
    await waitFor(() => expect(getWorkspaceSnapshot().openDrawer).toBe("import"));
    expect(getWorkspaceSnapshot().bandMode).toBe("template");
    expect(apiMocks.setSetting).toHaveBeenCalledWith("ui.home.template_preselect", "cinematic");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("当前集有素材时点模板卡先确认(会封存当前集),再点「确认新建」才真的建", async () => {
    feedMock.state = feed({ clips: [{ id: 1 }], episode: { activeId: 1, viewing: null, scopeId: 1, current: { ...ACTIVE, clip_count: 12 } } });
    pinHome(true);
    render(<HomeScreen />);
    const templates = screen.getByRole("group", { name: "从模板开始" });
    act(() => within(templates).getByRole("button", { name: /快节奏/ }).click());
    expect(apiMocks.createEpisode).not.toHaveBeenCalled();
    const confirm = screen.getByRole("status", { name: "模板确认" });
    expect(confirm.textContent).toContain("EP01 大理");
    await act(async () => {
      within(confirm).getByRole("button", { name: "确认新建" }).click();
    });
    await waitFor(() => expect(apiMocks.createEpisode).toHaveBeenCalledTimes(1));
    expect(apiMocks.createEpisode.mock.calls[0][0]).toMatch(/^快节奏 · /);
  });

  it("Y-01:首页盖着工作区时向播放器登记遮挡(原生视频层让位),卸载后解除", () => {
    pinHome(true);
    expect(isPlayerOccluded()).toBe(false);
    const { unmount } = render(<HomeScreen />);
    expect(isPlayerOccluded()).toBe(true);
    unmount();
    expect(isPlayerOccluded()).toBe(false);
  });
});
