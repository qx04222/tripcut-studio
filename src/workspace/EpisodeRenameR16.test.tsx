// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

/**
 * R16 车道 B P2-3:任意集「重命名」—— 切集弹层与首页集卡的「集操作 · <标题>」菜单第一项;
 * 内联表单「重命名集」(输入框「新的集标题」;Enter 提交、Esc 取消)→ `renameEpisode(id, title, theme)`。
 */

const active: EpisodeSummary = {
  id: 2,
  title: "建错的 EP2",
  theme: "",
  episode_number: 2,
  status: "active",
  created_at: "2026-09-01T00:00:00Z",
  archived_at: null,
  clip_count: 0,
  favorite_count: 0,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};
const archived: EpisodeSummary = { ...active, id: 1, title: "EP01", theme: "大理", episode_number: 1, status: "archived", archived_at: "2026-08-30T00:00:00Z", clip_count: 12 };

const apiMock = vi.hoisted(() => ({
  getCurrentEpisode: vi.fn(),
  listEpisodes: vi.fn(),
  archiveCurrentEpisode: vi.fn(),
  renameCurrentEpisode: vi.fn(),
  renameEpisode: vi.fn(),
  setEpisodePlatform: vi.fn(),
  createEpisode: vi.fn(),
  deleteEpisode: vi.fn(),
  listLibraries: vi.fn(async () => ({ active: "lib-1", libraries: [{ id: "lib-1", name: "默认库", hidden: false }] })),
  createLibrary: vi.fn(),
  setLibraryHidden: vi.fn(),
  switchLibrary: vi.fn(),
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api", () => apiMock);
const historyMock = vi.hoisted(() => ({ openHistoricalEpisode: vi.fn(), returnToActiveEpisode: vi.fn() }));
vi.mock("../historyView", () => historyMock);
const feedMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./useClipsFeed", () => ({ useClipsFeed: () => feedMock.state }));
const pipelineMock = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("./usePipeline", () => ({ usePipeline: () => pipelineMock.state }));

import { EpisodeSwitcher } from "./EpisodeSwitcher";
import { HomeScreen } from "./HomeScreen";
import { __resetHomeForTests } from "./homeStore";
import { __resetModalStackForTests } from "./modalStack";
import { derivePipeline } from "./pipelineModel";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

beforeEach(() => {
  __resetHomeForTests();
  __resetWorkspaceForTests();
  __resetModalStackForTests();
  pipelineMock.state = derivePipeline({ clipCount: 0, analysisPending: 0, segmentCount: 0, chapters: [], exportCount: 0 });
  feedMock.state = { clips: [], loading: false, episode: { activeId: 2, viewing: null, scopeId: 2, current: active } };
  apiMock.getCurrentEpisode.mockResolvedValue(active);
  apiMock.listEpisodes.mockResolvedValue([active, archived]);
  apiMock.renameEpisode.mockImplementation(async (id: number, title: string, theme: string) => ({ ...(id === 1 ? archived : active), title, theme }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("切集弹层", () => {
  it("已封存集的菜单第一项「重命名」→ 内联表单预填旧名;Enter → renameEpisode(1, 新名, 旧主题);列表刷新", async () => {
    render(<EpisodeSwitcher />);
    await flush();
    await act(async () => {
      screen.getByRole("button", { name: "切换集" }).click();
    });
    await flush();
    await act(async () => {
      screen.getByRole("button", { name: "集操作 · EP01" }).click();
    });
    const menu = screen.getByRole("menu", { name: "集操作 · EP01" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "删除这一集"]);
    await act(async () => {
      within(menu).getByRole("menuitem", { name: "重命名" }).click();
    });
    const form = screen.getByRole("form", { name: "重命名集" });
    const input = within(form).getByRole("textbox", { name: "新的集标题" }) as HTMLInputElement;
    expect(input.value).toBe("EP01");
    fireEvent.change(input, { target: { value: "EP01 大理三日" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await flush();
    expect(apiMock.renameEpisode).toHaveBeenCalledWith(1, "EP01 大理三日", "大理");
    expect(apiMock.renameCurrentEpisode).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "重命名集" })).toBeNull();
    expect(apiMock.listEpisodes.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole("status").textContent).toContain("已改名为「EP01 大理三日」");
  });

  it("Esc 取消不发命令;空名不提交;失败时表单留着并说清", async () => {
    render(<EpisodeSwitcher />);
    await flush();
    await act(async () => {
      screen.getByRole("button", { name: "切换集" }).click();
    });
    await flush();
    await act(async () => {
      screen.getByRole("button", { name: "集操作 · EP01" }).click();
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: "重命名" }).click();
    });
    const input = screen.getByRole("textbox", { name: "新的集标题" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(apiMock.renameEpisode).not.toHaveBeenCalled();
    apiMock.renameEpisode.mockRejectedValueOnce(new Error("集标题必须为 1-120 字"));
    fireEvent.change(input, { target: { value: "x" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await flush();
    expect(screen.getByRole("form", { name: "重命名集" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("集标题必须为 1-120 字");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "新的集标题" }), { key: "Escape" });
    expect(screen.queryByRole("form", { name: "重命名集" })).toBeNull();
  });
});

describe("首页集卡", () => {
  it("集卡菜单「重命名」→ 内联表单 → 保存按钮 → renameEpisode;卡片标题跟着变", async () => {
    render(<HomeScreen />);
    await flush();
    const list = screen.getByRole("list", { name: "最近的集" });
    await act(async () => {
      within(list).getByRole("button", { name: "集操作 · EP01" }).click();
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: "重命名" }).click();
    });
    const form = screen.getByRole("form", { name: "重命名集" });
    fireEvent.change(within(form).getByRole("textbox", { name: "新的集标题" }), { target: { value: "大理" } });
    apiMock.listEpisodes.mockResolvedValue([active, { ...archived, title: "大理" }]);
    await act(async () => {
      within(form).getByRole("button", { name: "保存" }).click();
    });
    await flush();
    expect(apiMock.renameEpisode).toHaveBeenCalledWith(1, "大理", "大理");
    expect(within(list).getByRole("button", { name: "集操作 · 大理" })).toBeTruthy();
  });
});
