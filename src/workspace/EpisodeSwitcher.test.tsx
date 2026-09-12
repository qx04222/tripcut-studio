// @vitest-environment jsdom
import { act } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EpisodeSummary } from "../api";

const active: EpisodeSummary = {
  id: 2,
  title: "EP01",
  theme: "",
  episode_number: 1,
  status: "active",
  created_at: "2026-09-01T00:00:00Z",
  archived_at: null,
  clip_count: 12,
  favorite_count: 3,
  export_count: 0,
  target_platform: "general",
  canvas_orientation: "landscape",
};
const archived: EpisodeSummary = {
  ...active,
  id: 1,
  title: "EP00",
  episode_number: 0,
  status: "archived",
  archived_at: "2026-08-30T00:00:00Z",
  export_count: 1,
};

const apiMock = vi.hoisted(() => ({
  getCurrentEpisode: vi.fn(),
  listEpisodes: vi.fn(),
  archiveCurrentEpisode: vi.fn(),
  renameCurrentEpisode: vi.fn(),
  setEpisodePlatform: vi.fn(),
  listLibraries: vi.fn(async () => ({ active: "lib-1", libraries: [{ id: "lib-1", name: "默认库", hidden: false }] })),
  createLibrary: vi.fn(),
  setLibraryHidden: vi.fn(),
  switchLibrary: vi.fn(),
}));
vi.mock("../api", () => apiMock);

const historyMock = vi.hoisted(() => ({ openHistoricalEpisode: vi.fn() }));
vi.mock("../historyView", () => historyMock);

import { EpisodeSwitcher } from "./EpisodeSwitcher";
import { __resetModalStackForTests, isAnyModalOpen, pushModal } from "./modalStack";

beforeEach(() => {
  apiMock.getCurrentEpisode.mockResolvedValue(active);
  apiMock.listEpisodes.mockResolvedValue([active, archived]);
  apiMock.archiveCurrentEpisode.mockResolvedValue({
    archived: { ...active, status: "archived" },
    next: { ...active, id: 3, title: "EP02" },
  });
  apiMock.renameCurrentEpisode.mockResolvedValue(active);
  apiMock.setEpisodePlatform.mockResolvedValue(undefined);
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
    const button = screen.getByRole("button", { name: "切换集" });
    button.focus();
    button.click();
    await Promise.resolve();
  });
}

describe("EpisodeSwitcher", () => {
  it("按钮 AX 名固定为「切换集」,可见文本含当前集标题(名不随数据漂移)", async () => {
    render(<EpisodeSwitcher />);
    await flush();
    const button = screen.getByRole("button", { name: "切换集" });
    expect(button.textContent).toContain("EP01");
    expect(button.textContent).toContain("通用");
  });

  it("点开 popover 有集列表、「重命名本集」与「封存本集」", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    expect(await screen.findByRole("button", { name: "重命名本集" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "封存本集" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "切换集" })).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name: "切换集" })).getByText("EP00")).toBeTruthy();
  });

  it("「重命名本集」里有「目标平台」(冒烟 topbar.episode.rename 升硬断言的依据)", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: "重命名本集" }).click();
    });
    expect(await screen.findByLabelText("目标平台")).toBeTruthy();
  });

  it("popover 底部一行是库路径 + 切换", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    expect(await screen.findByRole("button", { name: /素材库/ })).toBeTruthy();
  });

  it("点历史集进只读查看,不改当前集过滤", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByText("EP00").click();
    });
    expect(historyMock.openHistoricalEpisode).toHaveBeenCalledWith(1, "EP00");
    // popover 关闭,但没有触发任何"当前集"过滤/切换动作——只读查看不动 store。
    expect(screen.queryByRole("dialog", { name: "切换集" })).toBeNull();
  });

  it("Esc 关 popover,焦点回到「切换集」", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await screen.findByRole("dialog", { name: "切换集" });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "切换集" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "切换集" }));
  });

  it("popover 打开期间在模态栈里,关掉就出栈(监视器据此藏原生视频,R9 D1)", async () => {
    render(<EpisodeSwitcher />);
    await flush();
    expect(isAnyModalOpen()).toBe(false);
    await openSwitcher();
    await screen.findByRole("dialog", { name: "切换集" });
    expect(isAnyModalOpen()).toBe(true);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "切换集" })).toBeNull();
    expect(isAnyModalOpen()).toBe(false);
  });

  it("不是栈顶时 Esc 不关 popover(上面还压着别的层)", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await screen.findByRole("dialog", { name: "切换集" });
    pushModal({});
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.getByRole("dialog", { name: "切换集" })).toBeTruthy();
  });

  it("触发按钮的 aria-haspopup 与 popover 的 role 一致(都是 dialog)", async () => {
    // 之前是 aria-haspopup="menu" + role="menu",可里面装的是重命名表单、封存
    // 控件和素材库切换——没有一个 menuitem。两边一起改成 dialog(L8)。
    render(<EpisodeSwitcher />);
    await openSwitcher();
    expect(screen.getByRole("button", { name: "切换集" }).getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "切换集" })).toBeTruthy();
  });

  it("点 popover 之外的地方就收起来(L8)", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await screen.findByRole("dialog", { name: "切换集" });

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog", { name: "切换集" })).toBeNull();
  });

  it("点 popover 内部不会把它关掉(不然里面的表单一点就没)", async () => {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    const popover = await screen.findByRole("dialog", { name: "切换集" });

    await act(async () => {
      popover.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });
    expect(screen.getByRole("dialog", { name: "切换集" })).toBeTruthy();
  });

});
