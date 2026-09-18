// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({}) as Record<string, string>),
  setSetting: vi.fn(async () => undefined),
  listEpisodes: vi.fn(async () => [] as EpisodeSummary[]),
  createEpisode: vi.fn(async (title: string) => ({ episode: { ...ACTIVE, id: 9, title, clip_count: 0 }, reused_empty: false, archived: ACTIVE })),
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
import { FIRST_ROUND_VOCABULARY } from "./homeModel";
import { __resetHomeForTests, isHomePinned, pinHome } from "./homeStore";
import { __resetModalStackForTests } from "./modalStack";
import { ONBOARDING_STEPS } from "./onboarding";
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

/** R19 U-03:零术语首页 —— 一句话 + 「新建一集」/「继续上次」+ 最近的集;模板区撤;四步条改动作句。 */
describe("R19 U-03:零术语首页", () => {
  it("首页 DOM 文本不含首轮词表(镜头带 / 章节 / 精选段 / 交付 / 模板 / 旅程)—— 空库与有集两种状态", async () => {
    expect(FIRST_ROUND_VOCABULARY).toEqual(["镜头带", "章节", "精选段", "交付", "模板", "旅程"]);
    render(<HomeScreen />);
    const home = screen.getByRole("region", { name: "首页" });
    await within(home).findByRole("list", { name: "最近的集" });
    const text = home.textContent ?? "";
    for (const word of FIRST_ROUND_VOCABULARY) expect(text, `首页出现「${word}」`).not.toContain(word);
    expect(screen.queryByRole("group", { name: "从模板开始" })).toBeNull();
  });

  it("四步条是动作句:选文件夹 → 软件挑 / 你按 F → 拖顺序 → 交给剪映", () => {
    expect(ONBOARDING_STEPS.map((step) => step.title)).toEqual(["选文件夹", "软件挑 / 你按 F", "拖顺序", "交给剪映"]);
    render(<HomeScreen />);
    const steps = screen.getByRole("group", { name: "四步上手" });
    expect(steps.querySelectorAll("li")).toHaveLength(4);
    expect(steps.textContent).toContain("交给剪映");
  });

  it("当前集为空:唯一 primary「新建一集」= 打开导入抽屉(不新建档案);没有「继续上次」", () => {
    render(<HomeScreen />);
    const home = screen.getByRole("region", { name: "首页" });
    expect(home.querySelectorAll(".ui-button--primary")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "继续上次" })).toBeNull();
    pinHome(true);
    act(() => screen.getByRole("button", { name: "新建一集" }).click());
    expect(apiMocks.createEpisode).not.toHaveBeenCalled();
    expect(getWorkspaceSnapshot().openDrawer).toBe("import");
    expect(isHomePinned()).toBe(false);
  });

  it("当前集有素材:「继续上次」回工作区;「新建一集」先确认(会封存当前集),确认后新建 + 打开导入", async () => {
    feedMock.state = feed({ clips: [{ id: 1 }], episode: { activeId: 1, viewing: null, scopeId: 1, current: { ...ACTIVE, clip_count: 12 } } });
    pinHome(true);
    render(<HomeScreen />);
    act(() => screen.getByRole("button", { name: "继续上次" }).click());
    expect(isHomePinned()).toBe(false);
    expect(getWorkspaceSnapshot().openDrawer).toBeNull();

    pinHome(true);
    act(() => screen.getByRole("button", { name: "新建一集" }).click());
    expect(apiMocks.createEpisode).not.toHaveBeenCalled();
    const confirm = screen.getByRole("status", { name: "新建确认" });
    expect(confirm.textContent).toContain("EP01 大理");
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    await act(async () => {
      within(confirm).getByRole("button", { name: "确认新建" }).click();
    });
    await waitFor(() => expect(apiMocks.createEpisode).toHaveBeenCalledTimes(1));
    expect(apiMocks.createEpisode.mock.calls[0][0]).toMatch(/^新的一集 · \d{2}-\d{2}$/);
    await waitFor(() => expect(getWorkspaceSnapshot().openDrawer).toBe("import"));
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener("tripcut:episode-changed", changed);
  });
});
