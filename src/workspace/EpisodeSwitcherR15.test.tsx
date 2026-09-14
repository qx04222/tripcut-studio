// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

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
const archived: EpisodeSummary = {
  ...active,
  id: 1,
  title: "EP01",
  episode_number: 1,
  status: "archived",
  archived_at: "2026-08-30T00:00:00Z",
  clip_count: 12,
};

const apiMock = vi.hoisted(() => ({
  getCurrentEpisode: vi.fn(),
  listEpisodes: vi.fn(),
  archiveCurrentEpisode: vi.fn(),
  renameCurrentEpisode: vi.fn(),
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

import { EpisodeSwitcher } from "./EpisodeSwitcher";
import { __resetModalStackForTests } from "./modalStack";

beforeEach(() => {
  apiMock.getCurrentEpisode.mockResolvedValue(active);
  apiMock.listEpisodes.mockResolvedValue([active, archived]);
  apiMock.deleteEpisode.mockResolvedValue({
    deleted: active,
    active: { ...archived, status: "active", archived_at: null },
    created_fresh: false,
    removed_clips: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetModalStackForTests();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openSwitcher(): Promise<void> {
  await flush();
  await act(async () => {
    screen.getByRole("button", { name: "切换集" }).click();
    await Promise.resolve();
  });
  await flush();
}

describe("EpisodeSwitcher · R15 删除这一集", () => {
  it("每一集有「集操作 · <标题>」菜单,里面是「删除这一集」;确认块说明原片不会被删", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    const dialog = screen.getByRole("dialog", { name: "切换集" });
    await act(async () => {
      within(dialog).getByRole("button", { name: "集操作 · 建错的 EP2" }).click();
    });
    const menu = screen.getByRole("menu", { name: "集操作 · 建错的 EP2" });
    await act(async () => {
      within(menu).getByRole("menuitem", { name: "删除这一集" }).click();
    });
    const confirm = screen.getByRole("alertdialog", { name: "确认删除集" });
    expect(confirm.textContent).toContain("删除「建错的 EP2」");
    expect(confirm.textContent).toContain("原片不会被删");
    // 删的是当前集:说清删掉后回到哪一集。
    expect(confirm.textContent).toContain("回到「EP01」");
    expect(apiMock.deleteEpisode).not.toHaveBeenCalled();
  });

  it("确认后调 deleteEpisode,派发 tripcut:episode-changed(带新的当前集),提示写明原片没有动", async () => {
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: "集操作 · 建错的 EP2" }).click();
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: "删除这一集" }).click();
    });
    apiMock.getCurrentEpisode.mockResolvedValue({ ...archived, status: "active", archived_at: null });
    apiMock.listEpisodes.mockResolvedValue([{ ...archived, status: "active", archived_at: null }]);
    await act(async () => {
      within(screen.getByRole("alertdialog", { name: "确认删除集" })).getByRole("button", { name: "删除这一集" }).click();
      await Promise.resolve();
    });
    await flush();
    expect(apiMock.deleteEpisode).toHaveBeenCalledWith(2);
    expect(changed).toHaveBeenCalled();
    expect((changed.mock.calls[0]![0] as CustomEvent<{ id: number }>).detail.id).toBe(1);
    expect(screen.queryByRole("alertdialog", { name: "确认删除集" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("原片没有动");
    window.removeEventListener("tripcut:episode-changed", changed);
  });

  it("「取消」收起确认块,不调后端", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: "集操作 · EP01" }).click();
    });
    await act(async () => {
      screen.getByRole("menuitem", { name: "删除这一集" }).click();
    });
    await act(async () => {
      within(screen.getByRole("alertdialog", { name: "确认删除集" })).getByRole("button", { name: "取消" }).click();
    });
    expect(screen.queryByRole("alertdialog", { name: "确认删除集" })).toBeNull();
    expect(apiMock.deleteEpisode).not.toHaveBeenCalled();
  });
});
