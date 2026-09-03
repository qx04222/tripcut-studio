// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "./api";

const active: EpisodeSummary = {
  id: 2,
  title: "EP02 · 冰原公路",
  theme: "Icefields",
  episode_number: 2,
  status: "active",
  created_at: "2026-09-01T00:00:00Z",
  archived_at: null,
  clip_count: 12,
  favorite_count: 3,
  export_count: 0,
};
const archived: EpisodeSummary = {
  ...active,
  id: 1,
  title: "EP01",
  episode_number: 1,
  status: "archived",
  archived_at: "2026-08-30T00:00:00Z",
  export_count: 1,
};

const apiMock = vi.hoisted(() => ({
  getCurrentEpisode: vi.fn(),
  listEpisodes: vi.fn(),
  archiveCurrentEpisode: vi.fn(),
  renameCurrentEpisode: vi.fn(),
}));
vi.mock("./api", () => apiMock);

import { EpisodePanel } from "./EpisodePanel";

describe("EpisodePanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    apiMock.getCurrentEpisode.mockResolvedValue(active);
    apiMock.listEpisodes.mockResolvedValue([active, archived]);
    apiMock.archiveCurrentEpisode.mockResolvedValue({ archived: { ...active, status: "archived" }, next: { ...active, id: 3, title: "EP03" } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the active episode and the drawer lists archived ones read-only", async () => {
    await act(async () => root.render(<EpisodePanel />));
    expect(container.textContent).toContain("EP02 · 冰原公路");
    expect(container.textContent).toContain("12 素材");
    const toggle = container.querySelector<HTMLButtonElement>(".episode-current");
    await act(async () => toggle?.click());
    expect(container.textContent).toContain("EP01");
    expect(container.textContent).toContain("已封存 2026-08-30");
  });

  it("refreshes counts when the library changes", async () => {
    await act(async () => root.render(<EpisodePanel />));
    apiMock.getCurrentEpisode.mockResolvedValueOnce({
      ...active,
      clip_count: 13,
      favorite_count: 4,
    });
    apiMock.listEpisodes.mockResolvedValueOnce([
      { ...active, clip_count: 13, favorite_count: 4 },
      archived,
    ]);

    await act(async () => {
      window.dispatchEvent(new Event("tripcut:library-changed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("13 素材 · 4 收藏");
  });

  it("archive needs a second confirming click before calling the backend", async () => {
    await act(async () => root.render(<EpisodePanel />));
    const toggle = container.querySelector<HTMLButtonElement>(".episode-current");
    await act(async () => toggle?.click());
    const archiveButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "封存本集");
    await act(async () => archiveButton?.click());
    expect(apiMock.archiveCurrentEpisode).not.toHaveBeenCalled();
    expect(container.textContent).toContain("再次点击确认");
    const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("确认封存"));
    await act(async () => confirm?.click());
    expect(apiMock.archiveCurrentEpisode).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("已封存");
  });

  it("explains that an empty episode does not need archiving", async () => {
    apiMock.getCurrentEpisode.mockResolvedValueOnce({ ...active, clip_count: 0 });
    apiMock.listEpisodes.mockResolvedValueOnce([{ ...active, clip_count: 0 }, archived]);
    await act(async () => root.render(<EpisodePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".episode-current")?.click());

    const archiveButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "空集无需封存") as HTMLButtonElement | undefined;
    expect(archiveButton?.disabled).toBe(true);
    expect(container.textContent).toContain("请先导入素材");
    expect(apiMock.archiveCurrentEpisode).not.toHaveBeenCalled();
  });

  it("shows a user-facing rename error and clears it when editing is cancelled", async () => {
    apiMock.renameCurrentEpisode.mockRejectedValueOnce(new Error("storyboard failed: 集标题必须为 1-120 字"));
    await act(async () => root.render(<EpisodePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".episode-current")?.click());
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "重命名本集")?.click();
    });
    const title = container.querySelector<HTMLInputElement>('input[aria-label="集标题"]');
    await act(async () => {
      if (title) {
        title.value = "";
        title.dispatchEvent(new Event("input", { bubbles: true }));
      }
      [...container.querySelectorAll("button")].find((button) => button.textContent === "保存")?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("集标题必须为 1-120 字");
    expect(container.textContent).not.toContain("storyboard failed");
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "取消")?.click();
    });
    expect(container.textContent).not.toContain("集标题必须为 1-120 字");
  });

  it("switches every route to the new episode even when the list refresh fails", async () => {
    apiMock.getCurrentEpisode
      .mockResolvedValueOnce(active)
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    apiMock.listEpisodes
      .mockResolvedValueOnce([active, archived])
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    await act(async () => root.render(<EpisodePanel />));
    await act(async () => container.querySelector<HTMLButtonElement>(".episode-current")?.click());
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === "封存本集")?.click();
    });
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("确认封存"))?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(changed).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("集列表刷新失败");
    expect(container.textContent).toContain("EP03");
    window.removeEventListener("tripcut:episode-changed", changed);
  });
});
