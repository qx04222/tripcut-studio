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
  createEpisode: vi.fn(),
  listLibraries: vi.fn(async () => ({ active: "lib-1", libraries: [{ id: "lib-1", name: "默认库", hidden: false }] })),
  createLibrary: vi.fn(),
  setLibraryHidden: vi.fn(),
  switchLibrary: vi.fn(),
  // N-2:切换集读 store 的 viewingEpisode,store 模块顶层要拿 setSetting 建持久化写手。
  setSetting: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock("../api", () => apiMock);

const historyMock = vi.hoisted(() => ({ openHistoricalEpisode: vi.fn(), returnToActiveEpisode: vi.fn() }));
vi.mock("../historyView", () => historyMock);

import { EpisodeSwitcher } from "./EpisodeSwitcher";
import { __resetModalStackForTests, isAnyModalOpen, pushModal } from "./modalStack";
import { __resetWorkspaceForTests } from "./WorkspaceStore";

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

  it("R10 U-16:每次点开 popover 都重读集计数(导入后不再显示挂载时的「0 素材」)", async () => {
    render(<EpisodeSwitcher />);
    await flush();
    const callsAfterMount = apiMock.getCurrentEpisode.mock.calls.length;
    apiMock.getCurrentEpisode.mockResolvedValue({ ...active, clip_count: 21 });
    apiMock.listEpisodes.mockResolvedValue([{ ...active, clip_count: 21 }, archived]);
    await openSwitcher();
    await flush();
    expect(apiMock.getCurrentEpisode.mock.calls.length).toBeGreaterThan(callsAfterMount);
    const dialog = screen.getByRole("dialog", { name: "切换集" });
    expect(dialog.textContent).toContain("21 素材");
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

  /** N-2:只读查看历史集之后,弹层里点当前集要能回来(此前只是关掉弹层,池仍停在历史集)。 */
  it("只读查看中点当前集 → 回到当前集;没在只读查看时点当前集只关弹层", async () => {
    __resetWorkspaceForTests({ viewingEpisode: { id: 1, title: "EP00" } });
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: /EP01/ }).click();
    });
    expect(historyMock.returnToActiveEpisode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "切换集" })).toBeNull();

    historyMock.returnToActiveEpisode.mockClear();
    __resetWorkspaceForTests();
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: /EP01/ }).click();
    });
    expect(historyMock.returnToActiveEpisode).not.toHaveBeenCalled();
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

describe("「重命名本集」表单(R10 U-32:设计系统组件)", () => {
  async function openRename(): Promise<HTMLElement> {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: "重命名本集" }).click();
    });
    return screen.findByRole("form", { name: "重命名本集" });
  }

  it("集标题 / 集主题 / 目标平台 / 画布方向 / 保存 / 取消 的 AX 名不变;控件是套件 Field / Select / Chip / Button,没有原生 radio", async () => {
    const form = await openRename();
    expect(within(form).getByLabelText("集标题")).toBeTruthy();
    expect(within(form).getByLabelText("集主题")).toBeTruthy();
    expect(within(form).getByRole("combobox", { name: "目标平台" }).closest(".ui-select")).not.toBeNull();
    const orientation = within(form).getByRole("group", { name: "画布方向" });
    expect(within(orientation).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["横屏", "竖屏", "同时"]);
    expect(within(orientation).getByRole("button", { name: "横屏" }).getAttribute("aria-pressed")).toBe("true");
    expect(form.querySelector('input[type="radio"]')).toBeNull();
    expect(form.querySelector("fieldset")).toBeNull();
    expect(within(form).getByRole("button", { name: "保存" }).className).toContain("ui-button");
    expect(within(form).getByRole("button", { name: "取消" }).className).toContain("ui-button");
  });

  it("改方向 chip、改标题后保存:调 renameCurrentEpisode + setEpisodePlatform", async () => {
    const form = await openRename();
    await act(async () => {
      within(within(form).getByRole("group", { name: "画布方向" })).getByRole("button", { name: "竖屏" }).click();
    });
    const title = within(form).getByLabelText("集标题") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(title, "多伦多两日");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      within(form).getByRole("button", { name: "保存" }).click();
      await Promise.resolve();
    });
    expect(apiMock.renameCurrentEpisode).toHaveBeenCalledWith("多伦多两日", "");
    expect(apiMock.setEpisodePlatform).toHaveBeenCalledWith(2, "general", "portrait");
  });
});

describe("R10 U-16:popover 里的「新建集」", () => {
  async function openCreate(): Promise<HTMLElement> {
    render(<EpisodeSwitcher />);
    await openSwitcher();
    await act(async () => {
      screen.getByRole("button", { name: "新建集" }).click();
    });
    return screen.getByRole("form", { name: "新建集" });
  }

  function typeTitle(form: HTMLElement, value: string): Promise<void> {
    const title = within(form).getByLabelText("新集标题") as HTMLInputElement;
    return act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(title, value);
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("填名字提交:createEpisode(title) → 派发 tripcut:episode-changed → 提示封存与新集", async () => {
    apiMock.createEpisode.mockResolvedValue({
      episode: { ...active, id: 3, title: "京都三日", clip_count: 0 },
      reused_empty: false,
      archived: { ...active, status: "archived" },
    });
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    const form = await openCreate();
    await typeTitle(form, " 京都三日 ");
    await act(async () => {
      within(form).getByRole("button", { name: "创建" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    window.removeEventListener("tripcut:episode-changed", changed);
    expect(apiMock.createEpisode).toHaveBeenCalledWith("京都三日");
    expect(changed).toHaveBeenCalledTimes(1);
    expect((changed.mock.calls[0]![0] as CustomEvent).detail).toEqual({ id: 3, title: "京都三日" });
    expect(screen.getByRole("status").textContent).toContain("已封存「EP01」");
    expect(screen.getByRole("status").textContent).toContain("「京都三日」");
    expect(screen.queryByRole("form", { name: "新建集" })).toBeNull();
  });

  it("当前集为空被就地改名(reused_empty):提示「已就地改名」,同样派发 episode-changed", async () => {
    apiMock.createEpisode.mockResolvedValue({
      episode: { ...active, title: "京都三日", clip_count: 0 },
      reused_empty: true,
      archived: null,
    });
    const changed = vi.fn();
    window.addEventListener("tripcut:episode-changed", changed);
    const form = await openCreate();
    await typeTitle(form, "京都三日");
    await act(async () => {
      within(form).getByRole("button", { name: "创建" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    window.removeEventListener("tripcut:episode-changed", changed);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("已就地改名");
  });

  it("空名字不提交;createEpisode 抛错时错误可见、表单还在", async () => {
    apiMock.createEpisode.mockRejectedValue(new Error("集名不能为空"));
    const form = await openCreate();
    expect((within(form).getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(true);
    await typeTitle(form, "   ");
    expect((within(form).getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(true);
    expect(apiMock.createEpisode).not.toHaveBeenCalled();
    await typeTitle(form, "x");
    await act(async () => {
      within(form).getByRole("button", { name: "创建" }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toContain("集名不能为空");
    expect(screen.getByRole("form", { name: "新建集" })).toBeTruthy();
  });
});
